/**
 * @module agent/voice/voice-interface
 * @description Voice Interaction Orchestrator for the Agentic Commerce Gateway.
 *
 * Coordinates the full voice interaction pipeline:
 *   Voice Input → STT → Agent Core → TTS → Audio Output
 *
 * Key principle: Voice is a **transport layer**, not a separate commerce
 * implementation. All business logic (discovery, mandates, payments) is
 * delegated to the existing agent core. This module only handles:
 *   - Converting voice to text (STT)
 *   - Passing text through the agent pipeline
 *   - Converting agent responses back to speech (TTS)
 *   - Purchase confirmation prompt generation & parsing
 *
 * @see docs/TRD.md Section 5 — Voice Interaction Layer Specifications
 * @see docs/design.md Section 2.6 — Voice Interaction Decoupling
 * @see docs/ticket_04_voice_interaction_layer.md Section 2.3
 */

'use strict';

const STTEngine = require('./stt');
const TTSEngine = require('./tts');
const logger = require('../../lib/logger');

// ── Affirmative / Negative token sets ─────────────────────────────

const AFFIRMATIVE_TOKENS = new Set([
  'yes', 'confirm', 'proceed', 'yeah', 'sure', 'approve',
  'ok', 'okay', 'yep', 'yup', 'absolutely', 'go ahead',
  'do it', 'confirmed', 'approved', 'affirmative',
]);

const NEGATIVE_TOKENS = new Set([
  'no', 'cancel', 'stop', 'reject', 'nope', 'nah',
  'decline', 'abort', 'don\'t', 'negative', 'refused',
]);

// ── Voice Interface ───────────────────────────────────────────────

class VoiceInterface {
  /**
   * @param {Object} [options]
   * @param {Object} [options.sttOptions] - Options passed to STTEngine constructor
   * @param {Object} [options.ttsOptions] - Options passed to TTSEngine constructor
   * @param {Object} [options.agent] - Agent core instance (for processVoiceRequest delegation)
   */
  constructor(options = {}) {
    this.stt = new STTEngine(options.sttOptions || {});
    this.tts = new TTSEngine(options.ttsOptions || {});
    this.agent = options.agent || null;
  }

  /**
   * Process a full voice request through the agent pipeline.
   *
   * Flow: Audio → STT → Agent Core → TTS → Audio Response
   *
   * @param {Object} params
   * @param {Buffer|string} [params.audio] - Audio input data
   * @param {string} [params.text_fallback] - Text fallback for non-audio environments
   * @param {Object} [params.agent] - Override agent for this request
   * @param {Object} [params.context] - Additional context (delegator_id, constraints, etc.)
   *
   * @returns {Object} Voice response:
   *   {
   *     transcript: string,          - What the user said (STT output)
   *     stt_result: Object,          - Full STT result with confidence & source
   *     agent_response: Object|string, - Agent's text/structured response
   *     audio_output: Object,        - TTS audio response object
   *     channel: 'voice',            - Interaction channel marker
   *   }
   */
  processVoiceRequest({ audio, text_fallback, agent, context }) {
    // Step 1: Transcribe voice → text
    const sttResult = this.stt.transcribe(audio, { text_fallback });

    logger.info('[VoiceInterface] Voice request transcribed', {
      transcript: sttResult.transcript,
      confidence: sttResult.confidence,
      source: sttResult.source,
    });

    // Step 2: Pass through agent core
    const agentInstance = agent || this.agent;
    let agentResponse;

    if (agentInstance && typeof agentInstance.processQuery === 'function') {
      // Real agent integration
      agentResponse = agentInstance.processQuery(sttResult.transcript, context);
    } else {
      // No agent available — echo the transcript as the response
      // This allows the voice pipeline to be tested independently
      agentResponse = {
        text: `I heard: "${sttResult.transcript}". Let me help you find the best options.`,
        type: 'echo',
        query: sttResult.transcript,
      };
    }

    // Step 3: Synthesize response → audio
    const responseText = typeof agentResponse === 'string'
      ? agentResponse
      : agentResponse.text || JSON.stringify(agentResponse);

    const audioOutput = this.tts.synthesize(responseText, {
      context: 'general',
    });

    logger.info('[VoiceInterface] Voice response synthesized', {
      response_length: responseText.length,
      duration_ms: audioOutput.duration_ms,
    });

    return {
      transcript: sttResult.transcript,
      stt_result: sttResult,
      agent_response: agentResponse,
      audio_output: audioOutput,
      channel: 'voice',
    };
  }

  /**
   * Generate a verbal purchase confirmation prompt.
   *
   * Produces both a text prompt and a TTS audio object that can be
   * played back to the user before they confirm a purchase.
   *
   * @param {Object} params
   * @param {string} params.cart_id - Cart mandate ID for reference
   * @param {string} params.total_display - Formatted total (e.g. "₹3,799.00")
   * @param {string} [params.coupon_code] - Applied coupon code (if any)
   * @param {string} [params.product_name] - Primary product being purchased
   * @param {number} [params.item_count] - Number of items in cart
   *
   * @returns {Object} Confirmation prompt:
   *   {
   *     cart_id: string,
   *     prompt_text: string,        - Human-readable confirmation text
   *     audio_output: Object,       - TTS audio object for playback
   *     awaiting_response: true,    - Signal that we expect a yes/no reply
   *   }
   */
  promptVoiceConfirmation({ cart_id, total_display, coupon_code, product_name, item_count }) {
    // Build the spoken prompt text
    let promptText = `Your cart total is ${total_display}`;

    if (coupon_code) {
      promptText += ` after applying coupon ${coupon_code}`;
    }

    if (product_name) {
      promptText += `. You are purchasing ${product_name}`;
      if (item_count && item_count > 1) {
        promptText += ` and ${item_count - 1} other item${item_count > 2 ? 's' : ''}`;
      }
    }

    promptText += '. Do you confirm this purchase? Say yes to proceed or no to cancel.';

    // Synthesize the prompt
    const audioOutput = this.tts.synthesize(promptText, { context: 'confirmation' });

    logger.info('[VoiceInterface] Confirmation prompt generated', {
      cart_id,
      total_display,
      coupon_code: coupon_code || null,
      prompt_length: promptText.length,
    });

    return {
      cart_id,
      prompt_text: promptText,
      audio_output: audioOutput,
      awaiting_response: true,
    };
  }

  /**
   * Parse a voice confirmation response.
   *
   * Transcribes the user's audio reply and checks for affirmative or
   * negative tokens to determine if the purchase was confirmed.
   *
   * @param {Buffer|string} [audioInput] - Audio data of the user's reply
   * @param {string} [textFallback] - Text fallback (e.g. "yes" or "no")
   *
   * @returns {Object} Confirmation result:
   *   {
   *     confirmed: boolean,        - Whether the user confirmed the purchase
   *     raw_transcript: string,    - Raw transcribed text
   *     phrase: string,            - The matched token (e.g. 'yes', 'confirm')
   *     confidence: number,        - STT confidence score
   *     sentiment: string,         - 'AFFIRMATIVE' | 'NEGATIVE' | 'UNCLEAR'
   *   }
   */
  parseVoiceConfirmation(audioInput, textFallback) {
    // Transcribe the confirmation response
    const sttResult = this.stt.transcribe(audioInput, {
      text_fallback: textFallback,
    });

    const transcript = sttResult.transcript.toLowerCase().trim();

    // Check for affirmative tokens
    let matchedPhrase = null;
    let sentiment = 'UNCLEAR';

    // Check multi-word tokens first (e.g. "go ahead", "do it")
    for (const token of AFFIRMATIVE_TOKENS) {
      if (transcript.includes(token)) {
        matchedPhrase = token;
        sentiment = 'AFFIRMATIVE';
        break;
      }
    }

    // If not affirmative, check for negative tokens
    if (!matchedPhrase) {
      for (const token of NEGATIVE_TOKENS) {
        if (transcript.includes(token)) {
          matchedPhrase = token;
          sentiment = 'NEGATIVE';
          break;
        }
      }
    }

    const confirmed = sentiment === 'AFFIRMATIVE';

    logger.info('[VoiceInterface] Confirmation parsed', {
      raw_transcript: sttResult.transcript,
      sentiment,
      confirmed,
      matched_phrase: matchedPhrase,
    });

    return {
      confirmed,
      raw_transcript: sttResult.transcript,
      phrase: matchedPhrase || transcript,
      confidence: sttResult.confidence,
      sentiment,
    };
  }

  // ── Utility ────────────────────────────────────────────────────

  /**
   * Get the STT engine instance (for direct access in tests).
   * @returns {STTEngine}
   */
  getSTT() { return this.stt; }

  /**
   * Get the TTS engine instance (for direct access in tests).
   * @returns {TTSEngine}
   */
  getTTS() { return this.tts; }
}

module.exports = VoiceInterface;
