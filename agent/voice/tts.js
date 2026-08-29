/**
 * @module agent/voice/tts
 * @description Text-to-Speech (TTS) synthesizer for the Agentic Commerce Gateway.
 *
 * Converts agent text responses into speech-ready audio response objects.
 * Handles speech-friendly formatting of prices, coupon codes, and numbers
 * so synthesized audio sounds natural to the listener.
 *
 * In production this module would integrate with a real TTS provider
 * (Google Cloud TTS, Azure Speech, Web Speech API SpeechSynthesis).
 * The current implementation provides a fully functional simulation that
 * generates deterministic audio markers for end-to-end pipeline testing.
 *
 * @see docs/TRD.md Section 5 — Voice Interaction Layer Specifications
 * @see docs/ticket_04_voice_interaction_layer.md Section 2.2
 */

'use strict';

const logger = require('../../lib/logger');

// ── TTS Engine ────────────────────────────────────────────────────

class TTSEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.voice='en-IN-Wavenet-D'] - Voice model identifier
   * @param {string} [options.language='en-IN'] - BCP-47 language code
   * @param {number} [options.speakingRate=1.0] - Speaking rate multiplier (0.5–2.0)
   * @param {number} [options.pitch=0] - Pitch adjustment in semitones (-20 to +20)
   * @param {string} [options.audioEncoding='MP3'] - Output encoding (MP3, OGG_OPUS, LINEAR16)
   */
  constructor(options = {}) {
    this.voice = options.voice || 'en-IN-Wavenet-D';
    this.language = options.language || 'en-IN';
    this.speakingRate = options.speakingRate || 1.0;
    this.pitch = options.pitch || 0;
    this.audioEncoding = options.audioEncoding || 'MP3';
  }

  /**
   * Synthesize text into a speech-ready audio response object.
   *
   * @param {string} text - Text to synthesize into speech
   * @param {Object} [options]
   * @param {string} [options.voice] - Override voice for this call
   * @param {number} [options.speakingRate] - Override speaking rate
   * @param {string} [options.context] - Context hint: 'confirmation' | 'recommendation' | 'error' | 'general'
   *
   * @returns {Object} TTS response:
   *   {
   *     audio_data: Buffer,      - Simulated audio data
   *     audio_base64: string,    - Base64-encoded audio (for API transport)
   *     mime_type: string,       - MIME type (e.g. 'audio/mp3')
   *     text_content: string,    - Original text that was synthesized
   *     ssml_content: string,    - Speech-friendly formatted text
   *     duration_ms: number,     - Estimated playback duration
   *     voice: string,           - Voice model used
   *     language: string,        - Language used
   *   }
   */
  synthesize(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      logger.warn('[TTS] Empty text provided, returning silence marker');
      return this._createSilenceResponse();
    }

    const voice = options.voice || this.voice;
    const speakingRate = options.speakingRate || this.speakingRate;
    const context = options.context || 'general';

    // Convert text to speech-friendly SSML-like format
    const ssmlContent = this._formatForSpeech(text, context);

    // Estimate duration based on word count and speaking rate
    const wordCount = ssmlContent.split(/\s+/).length;
    const wordsPerMinute = 150 * speakingRate;
    const durationMs = Math.round((wordCount / wordsPerMinute) * 60 * 1000);

    // Generate simulated audio data (deterministic for testing)
    const audioData = this._generateSimulatedAudio(ssmlContent, durationMs);
    const audioBase64 = audioData.toString('base64');

    const mimeType = this._getMimeType(this.audioEncoding);

    logger.info('[TTS] Text synthesized', {
      text_length: text.length,
      word_count: wordCount,
      duration_ms: durationMs,
      voice,
      context,
    });

    return {
      audio_data: audioData,
      audio_base64: audioBase64,
      mime_type: mimeType,
      text_content: text,
      ssml_content: ssmlContent,
      duration_ms: durationMs,
      voice,
      language: this.language,
    };
  }

  /**
   * Generate a purchase confirmation prompt suitable for voice playback.
   *
   * @param {Object} params
   * @param {string} params.total_display - Formatted total (e.g. "₹3,799.00")
   * @param {string} [params.coupon_code] - Applied coupon code
   * @param {string} [params.product_name] - Primary product name
   * @param {number} [params.item_count] - Number of items in cart
   * @returns {Object} TTS response for the confirmation prompt
   */
  synthesizeConfirmation({ total_display, coupon_code, product_name, item_count }) {
    let prompt = 'Your cart total is ';
    prompt += this._priceToSpeech(total_display);

    if (coupon_code) {
      prompt += ` after applying coupon ${this._codeToSpeech(coupon_code)}`;
    }

    if (product_name) {
      prompt += `. You are purchasing ${product_name}`;
      if (item_count && item_count > 1) {
        prompt += ` and ${item_count - 1} other item${item_count > 2 ? 's' : ''}`;
      }
    }

    prompt += '. Do you confirm this purchase? Say yes to proceed or no to cancel.';

    return this.synthesize(prompt, { context: 'confirmation' });
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Format text for natural speech synthesis.
   * Converts prices, codes, abbreviations into spoken forms.
   * @private
   */
  _formatForSpeech(text, context) {
    let speech = text;

    // Convert INR prices: ₹3,799 → "3,799 Rupees"
    speech = speech.replace(/₹([\d,]+(?:\.\d{1,2})?)/g, (_, amount) => {
      return `${amount} Rupees`;
    });

    // Convert price displays with paise: "₹3,799.00" already handled above

    // Expand common abbreviations
    speech = speech.replace(/\bSTT\b/g, 'speech to text');
    speech = speech.replace(/\bTTS\b/g, 'text to speech');
    speech = speech.replace(/\bINR\b/g, 'Indian Rupees');
    speech = speech.replace(/\bACG\b/g, 'Agentic Commerce Gateway');

    // Add pauses around key phrases for confirmation context
    if (context === 'confirmation') {
      speech = speech.replace(/\. Do you/g, '... Do you');
      speech = speech.replace(/Say yes/g, '... Say yes');
    }

    return speech;
  }

  /**
   * Convert a price display string to speech-friendly form.
   * "₹3,799.00" → "3,799 Rupees"
   * @private
   */
  _priceToSpeech(priceStr) {
    if (!priceStr) return 'the total amount';
    return priceStr
      .replace(/₹/g, '')
      .replace(/\.00$/, '')
      .trim() + ' Rupees';
  }

  /**
   * Convert a coupon code to speech-friendly form.
   * "RUN500" → "R-U-N-5-0-0" (spelled out for clarity)
   * @private
   */
  _codeToSpeech(code) {
    if (!code) return '';
    return code.split('').join('-');
  }

  /**
   * Generate simulated audio buffer.
   * Creates a deterministic buffer based on text content and duration.
   * @private
   */
  _generateSimulatedAudio(text, durationMs) {
    // Create a buffer sized proportionally to duration
    // Real audio: ~16KB/sec for MP3 at 128kbps
    const bytesPerMs = 16; // ~16 bytes per ms at 128kbps
    const size = Math.max(256, Math.min(durationMs * bytesPerMs, 512000)); // cap at 512KB

    const buffer = Buffer.alloc(size);

    // Write a recognizable header for testing
    buffer.write('ACGTTS', 0, 'utf8');

    // Write text hash for determinism
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    buffer.writeInt32BE(hash, 8);
    buffer.writeInt32BE(durationMs, 12);

    // Fill remainder with simulated audio pattern
    for (let i = 16; i < size; i++) {
      buffer[i] = (hash + i * 7) & 0xFF;
    }

    return buffer;
  }

  /**
   * Create a silence response for empty input.
   * @private
   */
  _createSilenceResponse() {
    const silence = Buffer.alloc(256, 0);
    silence.write('ACGTTS_SILENCE', 0, 'utf8');

    return {
      audio_data: silence,
      audio_base64: silence.toString('base64'),
      mime_type: this._getMimeType(this.audioEncoding),
      text_content: '',
      ssml_content: '',
      duration_ms: 0,
      voice: this.voice,
      language: this.language,
    };
  }

  /**
   * Map encoding name to MIME type.
   * @private
   */
  _getMimeType(encoding) {
    const map = {
      MP3: 'audio/mp3',
      OGG_OPUS: 'audio/ogg',
      LINEAR16: 'audio/wav',
      FLAC: 'audio/flac',
    };
    return map[encoding] || 'audio/mp3';
  }
}

module.exports = TTSEngine;
