/**
 * @file demo/voice-demo.js
 * @description Interactive Voice Interaction CLI Demo for ACG v2.
 *
 * Allows you to manually test and inspect the Voice Interaction Layer:
 *   1. Enter a spoken query prompt (e.g., "I need running shoes under 5000")
 *   2. Watch Speech-to-Text (STT) transcribe & normalize the input
 *   3. Watch the Agent process the request & select products
 *   4. Watch Text-to-Speech (TTS) synthesize the response into speech-friendly SSML & audio buffers
 *   5. Experience the Verbal Purchase Confirmation prompt & parse your voice reply (yes/no/cancel)
 *
 * Usage:
 *   node demo/voice-demo.js
 */

'use strict';

const readline = require('readline');
const VoiceInterface = require('../agent/voice/voice-interface');

// ── ANSI Styling ──────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function banner(text) {
  console.log(`\n${c.cyan}${c.bold}═══════════════════════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.cyan}${c.bold}   ${text}${c.reset}`);
  console.log(`${c.cyan}${c.bold}═══════════════════════════════════════════════════════════════════${c.reset}\n`);
}

function section(title) {
  console.log(`\n${c.yellow}${c.bold}▶ ${title}${c.reset}`);
}

// ── Instantiate Voice Interface ───────────────────────────────────

const voiceInterface = new VoiceInterface();

// ── Readline setup ────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

// ── Main Demo Flow ────────────────────────────────────────────────

async function runVoiceDemo() {
  banner('AGENTIC COMMERCE GATEWAY — VOICE INTERACTION DEMO');

  console.log(`${c.dim}This interactive tool lets you test the Voice Interaction Layer manually.${c.reset}`);
  console.log(`${c.dim}Type what you would say into a microphone, or press Enter for a default sample.${c.reset}\n`);

  // ── Step 1: User Voice Prompt ──────────────────────────────────
  section('STEP 1: Speech-to-Text (STT) Input');

  const defaultPrompt = 'I need comfortable running shoes under 5000 rupees';
  const userInput = await askQuestion(`${c.bold}🗣️  Speak your prompt ${c.dim}(default: "${defaultPrompt}"):${c.reset} `);

  const voicePrompt = userInput.trim() || defaultPrompt;

  console.log(`\n${c.dim}[Processing Voice Input Stream...]${c.reset}`);

  // Transcribe via VoiceInterface / STT
  const voiceRequestResult = voiceInterface.processVoiceRequest({
    text_fallback: voicePrompt,
  });

  console.log(`\n${c.green}${c.bold}✔ STT Transcription Complete:${c.reset}`);
  console.log(`  • ${c.bold}Transcript:${c.reset}  "${voiceRequestResult.transcript}"`);
  console.log(`  • ${c.bold}Confidence:${c.reset}  ${(voiceRequestResult.stt_result.confidence * 100).toFixed(0)}%`);
  console.log(`  • ${c.bold}Source:${c.reset}      ${voiceRequestResult.stt_result.source}`);
  console.log(`  • ${c.bold}Language:${c.reset}    ${voiceRequestResult.stt_result.language}`);

  // ── Step 2: Agent Response & TTS ───────────────────────────────
  section('STEP 2: Agent Processing & Text-to-Speech (TTS) Output');

  console.log(`${c.green}${c.bold}✔ Agent Core Response:${c.reset}`);
  console.log(`  "${voiceRequestResult.agent_response.text}"`);

  console.log(`\n${c.magenta}${c.bold}✔ TTS Speech Synthesis Generated:${c.reset}`);
  console.log(`  • ${c.bold}Voice Model:${c.reset}   ${voiceRequestResult.audio_output.voice}`);
  console.log(`  • ${c.bold}MIME Type:${c.reset}     ${voiceRequestResult.audio_output.mime_type}`);
  console.log(`  • ${c.bold}Duration:${c.reset}      ${(voiceRequestResult.audio_output.duration_ms / 1000).toFixed(1)}s`);
  console.log(`  • ${c.bold}SSML Spoken Text:${c.reset}`);
  console.log(`    ${c.cyan}"${voiceRequestResult.audio_output.ssml_content}"${c.reset}`);
  console.log(`  • ${c.bold}Audio Buffer Size:${c.reset} ${voiceRequestResult.audio_output.audio_data.length} bytes`);
  console.log(`  • ${c.bold}Base64 Payload:${c.reset}    ${voiceRequestResult.audio_output.audio_base64.substring(0, 48)}...`);

  // ── Step 3: Verbal Purchase Confirmation Prompt ─────────────────
  section('STEP 3: Verbal Purchase Confirmation Gate');

  const confirmationPrompt = voiceInterface.promptVoiceConfirmation({
    cart_id: 'mdt_cart_demo888',
    total_display: '₹3,799.00',
    coupon_code: 'RUN500',
    product_name: 'Kalenji Run Support Running Shoes',
    item_count: 1,
  });

  console.log(`${c.bold}📢 Spoken Confirmation Prompt (played over speaker):${c.reset}`);
  console.log(`  ${c.cyan}"${confirmationPrompt.prompt_text}"${c.reset}\n`);

  console.log(`${c.dim}[TTS Formatted Speech: "${confirmationPrompt.audio_output.ssml_content}"]${c.reset}\n`);

  // ── Step 4: Parse Spoken Response ──────────────────────────────
  const defaultReply = 'yes proceed with order';
  const replyInput = await askQuestion(
    `${c.bold}🗣️  Speak your confirmation reply ${c.dim}(e.g. "yes", "no", "cancel" | default: "${defaultReply}"):${c.reset} `
  );

  const voiceReply = replyInput.trim() || defaultReply;

  console.log(`\n${c.dim}[Transcribing Voice Reply & Parsing Sentiment...]${c.reset}`);

  const confirmationResult = voiceInterface.parseVoiceConfirmation(null, voiceReply);

  section('STEP 4: Confirmation Result');

  console.log(`  • ${c.bold}Raw Transcript:${c.reset}    "${confirmationResult.raw_transcript}"`);
  console.log(`  • ${c.bold}Detected Sentiment:${c.reset} ${
    confirmationResult.sentiment === 'AFFIRMATIVE'
      ? `${c.green}${c.bold}AFFIRMATIVE${c.reset}`
      : confirmationResult.sentiment === 'NEGATIVE'
      ? `${c.red}${c.bold}NEGATIVE${c.reset}`
      : `${c.yellow}${c.bold}UNCLEAR${c.reset}`
  }`);
  console.log(`  • ${c.bold}Matched Token:${c.reset}     "${confirmationResult.phrase}"`);
  console.log(`  • ${c.bold}Purchase Status:${c.reset}   ${
    confirmationResult.confirmed
      ? `${c.green}${c.bold}✅ CONFIRMED — Ready for payment execution${c.reset}`
      : `${c.red}${c.bold}❌ DECLINED / REJECTED — Payment blocked${c.reset}`
  }`);

  banner('DEMO COMPLETE');
  rl.close();
}

runVoiceDemo().catch((err) => {
  console.error('\nDemo Error:', err);
  rl.close();
});
