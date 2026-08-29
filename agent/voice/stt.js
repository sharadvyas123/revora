/**
 * @module agent/voice/stt
 * @description Speech-to-Text (STT) transcriber for the Agentic Commerce Gateway.
 *
 * Converts audio input into normalized text prompts that feed the agent core
 * pipeline. Designed as a transport-layer abstraction — the STT module knows
 * nothing about mandates, products, or payments.
 *
 * Input modes:
 *   1. **Text fallback** — for CLI / unit tests (no audio hardware required)
 *   2. **Base64 audio** — simulated transcription from encoded audio data
 *   3. **Audio buffer** — simulated transcription from raw Buffer objects
 *
 * In a production deployment this module would integrate with a real STT
 * provider (Google Cloud Speech, Azure Cognitive Services, Web Speech API).
 * The current implementation provides a fully functional simulation layer
 * so the rest of the agent pipeline can be developed and tested end-to-end.
 *
 * @see docs/TRD.md Section 5 — Voice Interaction Layer Specifications
 * @see docs/ticket_04_voice_interaction_layer.md Section 2.1
 */

'use strict';

const { ACGError } = require('../../lib/errors');
const logger = require('../../lib/logger');

// ── Voice-specific errors ─────────────────────────────────────────

/**
 * Thrown when audio input cannot be transcribed.
 */
class VoiceSTTFailedError extends ACGError {
  constructor(reason) {
    super(`Voice transcription failed: ${reason}`, {
      code: 'VOICE_STT_FAILED',
      statusCode: 422,
      details: { reason },
      recovery: {
        action: 'RETRY_OR_TEXT',
        suggestion: 'Please speak clearly and try again, or switch to text input.',
      },
    });
  }
}

// ── STT Engine ────────────────────────────────────────────────────

class STTEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.language='en-IN'] - BCP-47 language code
   * @param {boolean} [options.profanityFilter=false] - Filter profanity
   * @param {number} [options.maxDurationMs=30000] - Max audio duration to process
   */
  constructor(options = {}) {
    this.language = options.language || 'en-IN';
    this.profanityFilter = options.profanityFilter || false;
    this.maxDurationMs = options.maxDurationMs || 30000;
  }

  /**
   * Transcribe audio input into a normalized text string.
   *
   * @param {Buffer|string|Object} audioInput - Audio data to transcribe.
   *   Accepted formats:
   *   - `string` with `text_fallback` in options → returns fallback directly
   *   - `Object` with `{ text_fallback }` → returns fallback text
   *   - `string` (base64-encoded audio) → simulated transcription
   *   - `Buffer` → simulated transcription from raw audio bytes
   *   - `null`/`undefined` → throws VOICE_STT_FAILED
   *
   * @param {Object} [options]
   * @param {string} [options.text_fallback] - Text to return when no real audio
   * @param {string} [options.language] - Override language for this call
   * @param {string} [options.encoding] - Audio encoding (e.g. 'LINEAR16', 'OGG_OPUS')
   * @param {number} [options.sampleRateHz] - Sample rate in Hz
   *
   * @returns {Object} Transcription result:
   *   {
   *     transcript: string,         - Normalized transcript text
   *     confidence: number,         - Confidence score 0.0–1.0
   *     language: string,           - Detected/used language
   *     source: string,             - 'text_fallback' | 'audio_buffer' | 'base64_audio'
   *     duration_ms: number|null    - Estimated audio duration
   *   }
   *
   * @throws {VoiceSTTFailedError} If input is null, empty, or unreadable
   */
  transcribe(audioInput, options = {}) {
    const language = options.language || this.language;

    // ── Mode 1: Text fallback (CLI / testing) ─────────────────────
    if (options.text_fallback) {
      const text = this._normalizeText(options.text_fallback);
      if (!text) {
        throw new VoiceSTTFailedError('Text fallback was provided but is empty.');
      }

      logger.info('[STT] Text fallback transcription', { text, language });

      return {
        transcript: text,
        confidence: 1.0,
        language,
        source: 'text_fallback',
        duration_ms: null,
      };
    }

    // ── Mode 2: Object with text_fallback field ──────────────────
    if (audioInput && typeof audioInput === 'object' && !Buffer.isBuffer(audioInput) && audioInput.text_fallback) {
      const text = this._normalizeText(audioInput.text_fallback);
      if (!text) {
        throw new VoiceSTTFailedError('Text fallback object contained empty text.');
      }

      logger.info('[STT] Object text_fallback transcription', { text, language });

      return {
        transcript: text,
        confidence: 1.0,
        language,
        source: 'text_fallback',
        duration_ms: null,
      };
    }

    // ── Guard: null / undefined / empty input ────────────────────
    if (audioInput == null) {
      throw new VoiceSTTFailedError('No audio input provided. Send audio data or use text_fallback.');
    }

    if (typeof audioInput === 'string' && audioInput.trim().length === 0) {
      throw new VoiceSTTFailedError('Audio input string is empty.');
    }

    if (Buffer.isBuffer(audioInput) && audioInput.length === 0) {
      throw new VoiceSTTFailedError('Audio buffer is empty (0 bytes).');
    }

    // ── Mode 3: Base64-encoded audio string ──────────────────────
    if (typeof audioInput === 'string') {
      try {
        const decoded = Buffer.from(audioInput, 'base64');
        if (decoded.length < 100) {
          throw new VoiceSTTFailedError('Audio data too short to contain speech (< 100 bytes).');
        }

        // Simulated transcription from base64 audio
        const simulatedText = this._simulateTranscription(decoded, language);

        logger.info('[STT] Base64 audio transcription', {
          bytes: decoded.length,
          transcript: simulatedText,
          language,
        });

        return {
          transcript: simulatedText,
          confidence: 0.85,
          language,
          source: 'base64_audio',
          duration_ms: this._estimateDuration(decoded.length),
        };
      } catch (err) {
        if (err instanceof VoiceSTTFailedError) throw err;
        throw new VoiceSTTFailedError(`Failed to decode base64 audio: ${err.message}`);
      }
    }

    // ── Mode 4: Raw audio Buffer ─────────────────────────────────
    if (Buffer.isBuffer(audioInput)) {
      if (audioInput.length < 100) {
        throw new VoiceSTTFailedError('Audio buffer too short to contain speech (< 100 bytes).');
      }

      const simulatedText = this._simulateTranscription(audioInput, language);

      logger.info('[STT] Audio buffer transcription', {
        bytes: audioInput.length,
        transcript: simulatedText,
        language,
      });

      return {
        transcript: simulatedText,
        confidence: 0.88,
        language,
        source: 'audio_buffer',
        duration_ms: this._estimateDuration(audioInput.length),
      };
    }

    // ── Unsupported input type ───────────────────────────────────
    throw new VoiceSTTFailedError(
      `Unsupported audio input type: ${typeof audioInput}. Expected Buffer, base64 string, or text_fallback.`
    );
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Normalize transcript text: trim, collapse whitespace, lowercase for matching.
   * @private
   */
  _normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.trim().replace(/\s+/g, ' ');
  }

  /**
   * Simulate transcription from audio bytes.
   * In production, this would call a real STT API.
   * For simulation, we generate a plausible transcript based on audio length.
   * @private
   */
  _simulateTranscription(audioBuffer, language) {
    // Use audio byte patterns to deterministically generate "transcripts"
    // so tests can rely on predictable output from known inputs.
    const byteSum = audioBuffer.slice(0, 20).reduce((sum, b) => sum + b, 0);
    const phrases = [
      'I need running shoes under five thousand rupees',
      'Find me the best deal on wireless headphones',
      'Show me comfortable sneakers for daily use',
      'What sports shoes do you recommend',
      'Compare the top three options for me',
    ];
    return phrases[byteSum % phrases.length];
  }

  /**
   * Estimate audio duration from buffer size.
   * Assumes 16kHz, 16-bit mono PCM (32,000 bytes/sec).
   * @private
   */
  _estimateDuration(byteLength) {
    const bytesPerSecond = 32000; // 16kHz × 16-bit × 1 channel
    return Math.round((byteLength / bytesPerSecond) * 1000);
  }
}

// ── Exports ──────────────────────────────────────────────────────

module.exports = STTEngine;
module.exports.VoiceSTTFailedError = VoiceSTTFailedError;
