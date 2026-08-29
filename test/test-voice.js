/**
 * @file test/test-voice.js
 * @description Automated test suite for Phase 12 — Voice Interaction Layer.
 *
 * Covers:
 *   1. STT Engine — text fallback, object fallback, buffer/base64, error cases
 *   2. TTS Engine — synthesis, speech-friendly formatting, confirmation prompts
 *   3. Voice Interface — processVoiceRequest pipeline, confirmation prompts, parsing
 *   4. Affirmative / Negative / Unclear token detection
 *
 * Run with:
 *   node test/test-voice.js
 */

'use strict';

// ── ANSI colours ─────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

// ── Test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log(`  ${GREEN}✔${RESET} ${name}`);
}
function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`  ${RED}✘ ${name}${RESET}`);
  console.log(`      ${RED}→ ${reason}${RESET}`);
}
function section(title) {
  console.log(`\n${BOLD}${CYAN}▶ ${title}${RESET}`);
}
function assert(name, condition, message) {
  condition ? pass(name) : fail(name, message || 'Assertion failed');
}

// ═══════════════════════════════════════════════════════════════════
//  Load modules
// ═══════════════════════════════════════════════════════════════════

const STTEngine = require('../agent/voice/stt');
const TTSEngine = require('../agent/voice/tts');
const VoiceInterface = require('../agent/voice/voice-interface');

// ═══════════════════════════════════════════════════════════════════
//  1. STT Engine Tests
// ═══════════════════════════════════════════════════════════════════

section('STT Engine — Text Fallback');

{
  const stt = new STTEngine();

  // Text fallback via options
  const r = stt.transcribe(null, { text_fallback: 'I need running shoes' });
  assert('Text fallback: transcript correct', r.transcript === 'I need running shoes', `Got: "${r.transcript}"`);
  assert('Text fallback: confidence = 1.0', r.confidence === 1.0, `Got: ${r.confidence}`);
  assert('Text fallback: source = text_fallback', r.source === 'text_fallback', `Got: ${r.source}`);
  assert('Text fallback: duration_ms = null', r.duration_ms === null, `Got: ${r.duration_ms}`);
}

{
  const stt = new STTEngine();

  // Text fallback with extra whitespace → normalized
  const r = stt.transcribe(null, { text_fallback: '  find   me  shoes  ' });
  assert('Text fallback: normalizes whitespace', r.transcript === 'find me shoes', `Got: "${r.transcript}"`);
}

section('STT Engine — Object Fallback');

{
  const stt = new STTEngine();

  // Object with text_fallback field
  const r = stt.transcribe({ text_fallback: 'Compare top options' });
  assert('Object fallback: transcript correct', r.transcript === 'Compare top options', `Got: "${r.transcript}"`);
  assert('Object fallback: source = text_fallback', r.source === 'text_fallback', `Got: ${r.source}`);
}

section('STT Engine — Audio Buffer');

{
  const stt = new STTEngine();

  // Create a realistic-sized audio buffer (> 100 bytes)
  const buf = Buffer.alloc(5000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 42) & 0xFF;

  const r = stt.transcribe(buf);
  assert('Audio buffer: returns transcript', typeof r.transcript === 'string' && r.transcript.length > 0,
    `Got: "${r.transcript}"`);
  assert('Audio buffer: source = audio_buffer', r.source === 'audio_buffer', `Got: ${r.source}`);
  assert('Audio buffer: has duration_ms', typeof r.duration_ms === 'number' && r.duration_ms > 0,
    `Got: ${r.duration_ms}`);
  assert('Audio buffer: confidence < 1.0 (simulated)', r.confidence < 1.0, `Got: ${r.confidence}`);
}

section('STT Engine — Base64 Audio');

{
  const stt = new STTEngine();

  // Create a base64-encoded audio string (> 100 bytes decoded)
  const raw = Buffer.alloc(500);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 99) & 0xFF;
  const b64 = raw.toString('base64');

  const r = stt.transcribe(b64);
  assert('Base64 audio: returns transcript', typeof r.transcript === 'string' && r.transcript.length > 0,
    `Got: "${r.transcript}"`);
  assert('Base64 audio: source = base64_audio', r.source === 'base64_audio', `Got: ${r.source}`);
}

section('STT Engine — Error Cases');

{
  const stt = new STTEngine();

  // Null input → VOICE_STT_FAILED
  let threw = null;
  try { stt.transcribe(null); } catch (e) { threw = e; }
  assert('Null input: throws VOICE_STT_FAILED', threw?.code === 'VOICE_STT_FAILED',
    `Got: ${threw?.code} — ${threw?.message}`);
}

{
  const stt = new STTEngine();

  // Empty string → VOICE_STT_FAILED
  let threw = null;
  try { stt.transcribe(''); } catch (e) { threw = e; }
  assert('Empty string: throws VOICE_STT_FAILED', threw?.code === 'VOICE_STT_FAILED',
    `Got: ${threw?.code}`);
}

{
  const stt = new STTEngine();

  // Empty buffer → VOICE_STT_FAILED
  let threw = null;
  try { stt.transcribe(Buffer.alloc(0)); } catch (e) { threw = e; }
  assert('Empty buffer: throws VOICE_STT_FAILED', threw?.code === 'VOICE_STT_FAILED',
    `Got: ${threw?.code}`);
}

{
  const stt = new STTEngine();

  // Too-small buffer (< 100 bytes) → VOICE_STT_FAILED
  let threw = null;
  try { stt.transcribe(Buffer.alloc(50)); } catch (e) { threw = e; }
  assert('Tiny buffer (50 bytes): throws VOICE_STT_FAILED', threw?.code === 'VOICE_STT_FAILED',
    `Got: ${threw?.code}`);
}

{
  const stt = new STTEngine();

  // Empty text_fallback → VOICE_STT_FAILED
  let threw = null;
  try { stt.transcribe(null, { text_fallback: '   ' }); } catch (e) { threw = e; }
  assert('Empty text_fallback: throws VOICE_STT_FAILED', threw?.code === 'VOICE_STT_FAILED',
    `Got: ${threw?.code}`);
}

{
  const stt = new STTEngine();

  // Error has 422 statusCode
  let threw = null;
  try { stt.transcribe(null); } catch (e) { threw = e; }
  assert('VOICE_STT_FAILED: statusCode = 422', threw?.statusCode === 422,
    `Got: ${threw?.statusCode}`);
  assert('VOICE_STT_FAILED: has recovery action', threw?.recovery?.action === 'RETRY_OR_TEXT',
    `Got: ${threw?.recovery?.action}`);
}

// ═══════════════════════════════════════════════════════════════════
//  2. TTS Engine Tests
// ═══════════════════════════════════════════════════════════════════

section('TTS Engine — synthesize()');

{
  const tts = new TTSEngine();

  const r = tts.synthesize('Your order has been confirmed. Thank you for shopping!');
  assert('Synthesize: returns audio_data Buffer', Buffer.isBuffer(r.audio_data), `Type: ${typeof r.audio_data}`);
  assert('Synthesize: audio_data.length > 0', r.audio_data.length > 0, `Length: ${r.audio_data.length}`);
  assert('Synthesize: has audio_base64 string', typeof r.audio_base64 === 'string' && r.audio_base64.length > 0,
    'audio_base64 missing');
  assert('Synthesize: mime_type = audio/mp3', r.mime_type === 'audio/mp3', `Got: ${r.mime_type}`);
  assert('Synthesize: text_content preserved', r.text_content === 'Your order has been confirmed. Thank you for shopping!',
    `Got: "${r.text_content}"`);
  assert('Synthesize: duration_ms > 0', r.duration_ms > 0, `Got: ${r.duration_ms}`);
  assert('Synthesize: has voice field', typeof r.voice === 'string', 'voice missing');
  assert('Synthesize: has language field', r.language === 'en-IN', `Got: ${r.language}`);
}

section('TTS Engine — Speech Formatting');

{
  const tts = new TTSEngine();

  // Price formatting
  const r = tts.synthesize('The total is ₹3,799.00 including taxes.');
  assert('Price formatting: ₹ → Rupees', r.ssml_content.includes('3,799.00 Rupees'),
    `Got: "${r.ssml_content}"`);
  assert('Price formatting: no ₹ symbol in SSML', !r.ssml_content.includes('₹'),
    `Still has ₹: "${r.ssml_content}"`);
}

{
  const tts = new TTSEngine();

  // Abbreviation expansion
  const r = tts.synthesize('The INR amount for ACG checkout');
  assert('Abbreviation: INR → Indian Rupees', r.ssml_content.includes('Indian Rupees'),
    `Got: "${r.ssml_content}"`);
  assert('Abbreviation: ACG → Agentic Commerce Gateway', r.ssml_content.includes('Agentic Commerce Gateway'),
    `Got: "${r.ssml_content}"`);
}

section('TTS Engine — Empty Input');

{
  const tts = new TTSEngine();

  const r = tts.synthesize('');
  assert('Empty input: returns silence', r.duration_ms === 0, `Got duration: ${r.duration_ms}`);
  assert('Empty input: text_content is empty', r.text_content === '', `Got: "${r.text_content}"`);
}

section('TTS Engine — synthesizeConfirmation()');

{
  const tts = new TTSEngine();

  const r = tts.synthesizeConfirmation({
    total_display: '₹3,799.00',
    coupon_code: 'RUN500',
    product_name: 'Kalenji Run Support Running Shoes',
    item_count: 1,
  });

  assert('Confirmation: has audio_data', Buffer.isBuffer(r.audio_data), 'Missing audio_data');
  assert('Confirmation: text mentions Rupees', r.ssml_content.includes('Rupees'),
    `No "Rupees": "${r.ssml_content}"`);
  assert('Confirmation: text mentions coupon', r.ssml_content.includes('R-U-N-5-0-0'),
    `No coupon: "${r.ssml_content}"`);
  assert('Confirmation: text mentions product', r.text_content.includes('Kalenji'),
    `No product: "${r.text_content}"`);
  assert('Confirmation: asks for confirmation', r.text_content.includes('Do you confirm'),
    `No confirmation ask: "${r.text_content}"`);
}

{
  const tts = new TTSEngine();

  // Without coupon
  const r = tts.synthesizeConfirmation({
    total_display: '₹5,000.00',
    product_name: 'Nike Air Max',
    item_count: 3,
  });
  assert('Confirmation (no coupon): no coupon text', !r.text_content.includes('coupon'),
    `Unexpected coupon: "${r.text_content}"`);
  assert('Confirmation (multi-item): mentions other items', r.text_content.includes('2 other items'),
    `No multi-item: "${r.text_content}"`);
}

// ═══════════════════════════════════════════════════════════════════
//  3. Voice Interface — processVoiceRequest
// ═══════════════════════════════════════════════════════════════════

section('VoiceInterface — processVoiceRequest()');

{
  const vi = new VoiceInterface();

  // Text fallback → echo response (no real agent)
  const r = vi.processVoiceRequest({ text_fallback: 'Find me running shoes under 5000' });
  assert('processVoiceRequest: transcript set', r.transcript === 'Find me running shoes under 5000',
    `Got: "${r.transcript}"`);
  assert('processVoiceRequest: has stt_result', r.stt_result?.source === 'text_fallback',
    `Got source: ${r.stt_result?.source}`);
  assert('processVoiceRequest: agent_response.type = echo', r.agent_response?.type === 'echo',
    `Got: ${r.agent_response?.type}`);
  assert('processVoiceRequest: has audio_output', Buffer.isBuffer(r.audio_output?.audio_data),
    'Missing audio_output');
  assert('processVoiceRequest: channel = voice', r.channel === 'voice',
    `Got: ${r.channel}`);
}

{
  // With mock agent
  const mockAgent = {
    processQuery: (query) => ({
      text: `Found 3 options for "${query}". Best match: Nike Air Max ₹4,500.`,
      type: 'recommendation',
    }),
  };

  const vi = new VoiceInterface({ agent: mockAgent });
  const r = vi.processVoiceRequest({ text_fallback: 'Running shoes' });
  assert('processVoiceRequest (with agent): uses agent response',
    r.agent_response?.type === 'recommendation',
    `Got type: ${r.agent_response?.type}`);
  assert('processVoiceRequest (with agent): response mentions Nike',
    r.agent_response?.text?.includes('Nike'),
    `Got: "${r.agent_response?.text}"`);
}

// ═══════════════════════════════════════════════════════════════════
//  4. Voice Interface — promptVoiceConfirmation
// ═══════════════════════════════════════════════════════════════════

section('VoiceInterface — promptVoiceConfirmation()');

{
  const vi = new VoiceInterface();

  const r = vi.promptVoiceConfirmation({
    cart_id: 'mdt_cart_abc123',
    total_display: '₹3,799.00',
    coupon_code: 'RUN500',
    product_name: 'Kalenji Run Support',
    item_count: 1,
  });

  assert('promptConfirmation: cart_id preserved', r.cart_id === 'mdt_cart_abc123',
    `Got: ${r.cart_id}`);
  assert('promptConfirmation: prompt_text includes total', r.prompt_text.includes('₹3,799.00'),
    `Got: "${r.prompt_text}"`);
  assert('promptConfirmation: prompt_text includes coupon', r.prompt_text.includes('RUN500'),
    `Got: "${r.prompt_text}"`);
  assert('promptConfirmation: prompt_text includes product', r.prompt_text.includes('Kalenji'),
    `Got: "${r.prompt_text}"`);
  assert('promptConfirmation: asks yes/no', r.prompt_text.includes('Say yes to proceed'),
    `Got: "${r.prompt_text}"`);
  assert('promptConfirmation: awaiting_response = true', r.awaiting_response === true,
    `Got: ${r.awaiting_response}`);
  assert('promptConfirmation: has audio_output', Buffer.isBuffer(r.audio_output?.audio_data),
    'Missing audio_output');
}

{
  const vi = new VoiceInterface();

  // Without coupon
  const r = vi.promptVoiceConfirmation({
    cart_id: 'mdt_cart_xyz',
    total_display: '₹5,000.00',
  });

  assert('promptConfirmation (no coupon): no coupon text', !r.prompt_text.includes('coupon'),
    `Unexpected coupon: "${r.prompt_text}"`);
  assert('promptConfirmation (no coupon): still asks for confirmation',
    r.prompt_text.includes('Do you confirm'), `No confirm ask: "${r.prompt_text}"`);
}

// ═══════════════════════════════════════════════════════════════════
//  5. Voice Interface — parseVoiceConfirmation (Affirmative)
// ═══════════════════════════════════════════════════════════════════

section('VoiceInterface — parseVoiceConfirmation (Affirmative)');

{
  const vi = new VoiceInterface();

  const affirmatives = ['yes', 'Yes please', 'confirm', 'Proceed with purchase', 'yeah', 'Sure!', 'ok', 'okay', 'go ahead'];
  for (const phrase of affirmatives) {
    const r = vi.parseVoiceConfirmation(null, phrase);
    assert(`Affirmative: "${phrase}" → confirmed=true`,
      r.confirmed === true && r.sentiment === 'AFFIRMATIVE',
      `confirmed=${r.confirmed}, sentiment=${r.sentiment}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  6. Voice Interface — parseVoiceConfirmation (Negative)
// ═══════════════════════════════════════════════════════════════════

section('VoiceInterface — parseVoiceConfirmation (Negative)');

{
  const vi = new VoiceInterface();

  const negatives = ['no', 'No thanks', 'cancel', 'stop', 'Nope', 'reject this'];
  for (const phrase of negatives) {
    const r = vi.parseVoiceConfirmation(null, phrase);
    assert(`Negative: "${phrase}" → confirmed=false`,
      r.confirmed === false && r.sentiment === 'NEGATIVE',
      `confirmed=${r.confirmed}, sentiment=${r.sentiment}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  7. Voice Interface — parseVoiceConfirmation (Unclear)
// ═══════════════════════════════════════════════════════════════════

section('VoiceInterface — parseVoiceConfirmation (Unclear)');

{
  const vi = new VoiceInterface();

  const unclear = ['hmm let me think', 'what is the price again', 'maybe later'];
  for (const phrase of unclear) {
    const r = vi.parseVoiceConfirmation(null, phrase);
    assert(`Unclear: "${phrase}" → confirmed=false, sentiment=UNCLEAR`,
      r.confirmed === false && r.sentiment === 'UNCLEAR',
      `confirmed=${r.confirmed}, sentiment=${r.sentiment}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  RESULTS
// ═══════════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(55));
const total = passed + failed;
const colour = failed > 0 ? RED : GREEN;
console.log(`${BOLD}${colour}Results: ${passed}/${total} passed, ${failed} failed${RESET}`);

if (failures.length > 0) {
  console.log(`\n${RED}${BOLD}Failed tests:${RESET}`);
  failures.forEach((f) => console.log(`  ${RED}✘ ${f.name}${RESET}\n      ${f.reason}`));
}

process.exit(failed > 0 ? 1 : 0);
