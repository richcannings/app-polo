/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createChunkedRecorder, createStreamingRecorder } from './audio'
import { transcribeAudio } from './whisper'
import { extractQSO, extractCW } from './extractor'
import * as CWExtractor from './cw-extractor'
import * as GGMorse from './ggmorse'

// --- State ---
let state = 'idle' // idle | listening | processing | paused | error
let listeners = []
let recorder = null
let apiKey = null
let pipelineBusy = false

// Callbacks from React component (set/cleared on mount/unmount)
let updateQSOFn = null
let onSubmitFn = null
let handleFieldChangeFn = null
let correctLogEntryFn = null
let changeVFOFn = null

// Session context
let sessionContext = {
  operatorCall: '',
  band: '',
  mode: '',
  currentQSOCall: '',
  recentQSOs: []
}

// Field locking
let lockedFields = new Set()
let lastWrittenValues = {}

// Auto-submit cooldown
let submitCooldownActive = false
let submitCooldownTimer = null

// Pending results buffer (for when callbacks are null)
let pendingResults = []

// Last transcript for display
let lastTranscript = ''
let lastStatus = ''

// CW mode state
let cwTextBuffer = ''
let cwExtractionTimer = null
let cwUnsubText = null
let cwUnsubStats = null

// --- Listener pattern ---
function setState (newState) {
  state = newState
  notifyListeners()
}

function notifyListeners () {
  const mode = isCWMode() ? 'CW' : 'SSB'
  listeners.forEach(fn => {
    try { fn({ state, lastTranscript, lastStatus, mode }) } catch (e) { /* ignore */ }
  })
}

export function subscribe (fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter(l => l !== fn) }
}

export function getState () {
  return { state, lastTranscript, lastStatus, mode: isCWMode() ? 'CW' : 'SSB' }
}

// --- Callbacks ---
export function setCallbacks ({ updateQSO, onSubmitEditing, handleFieldChange, correctLogEntry, changeVFO }) {
  console.log('VoiceLogging: setCallbacks', !!updateQSO, !!onSubmitEditing, !!handleFieldChange, !!correctLogEntry, !!changeVFO)
  updateQSOFn = updateQSO
  onSubmitFn = onSubmitEditing
  handleFieldChangeFn = handleFieldChange
  correctLogEntryFn = correctLogEntry
  changeVFOFn = changeVFO

  // Drain pending results
  if (pendingResults.length > 0) {
    const results = [...pendingResults]
    pendingResults = []
    results.forEach(result => applyExtraction(result))
  }
}

export function clearCallbacks () {
  updateQSOFn = null
  onSubmitFn = null
  handleFieldChangeFn = null
  correctLogEntryFn = null
  changeVFOFn = null
}

export function setSessionContext (ctx) {
  sessionContext = { ...sessionContext, ...ctx }
}

// --- Field locking ---
export function lockField (fieldId) {
  lockedFields.add(fieldId)
}

function clearLocks () {
  lockedFields.clear()
  lastWrittenValues = {}
}

export function getLastWrittenValues () {
  return { ...lastWrittenValues }
}

// Manual field population from ticker tape tap
export function populateField (fieldId, value) {
  if (!value) return
  if (fieldId === 'theirCall' && handleFieldChangeFn) {
    const v = value.toUpperCase()
    handleFieldChangeFn({ fieldId: 'theirCall', value: v })
    lastWrittenValues.theirCall = v
    sessionContext.currentQSOCall = v
  } else if (fieldId === 'ourSent' && updateQSOFn) {
    updateQSOFn({ our: { sent: value } })
    lastWrittenValues.ourSent = value
  } else if (fieldId === 'theirSent' && updateQSOFn) {
    updateQSOFn({ their: { sent: value } })
    lastWrittenValues.theirSent = value
  } else if (fieldId === 'state' && handleFieldChangeFn) {
    const v = value.toUpperCase()
    handleFieldChangeFn({ fieldId: 'state', value: v })
    lastWrittenValues.state = v
  }
}

// --- Pipeline ---
async function handleChunk (wavPath) {
  if (pipelineBusy) {
    console.log('VoiceLogging: Pipeline busy, dropping chunk')
    return
  }

  pipelineBusy = true
  setState('processing')

  try {
    // Step 1: Whisper (pass session context for better transcription)
    const transcript = await transcribeAudio(wavPath, apiKey, sessionContext)
    lastTranscript = transcript
    console.log('VoiceLogging: Transcript:', transcript)
    notifyListeners()

    // Step 2: GPT extraction
    const result = await extractQSO(transcript, apiKey, sessionContext)

    // Step 3: Apply result
    lastStatus = `${result.intent}: ${result.callsign || '(none)'}`
    applyExtraction(result)
  } catch (err) {
    console.log('VoiceLogging: Pipeline error:', err.message)
    lastStatus = `error: ${err.message}`
  } finally {
    pipelineBusy = false
    if (state !== 'paused' && state !== 'idle') {
      setState('listening')
    }
  }
}

function handleSilence () {
  lastStatus = 'silence (skipped)'
  notifyListeners()
}

function applyExtraction (result) {
  console.log('VoiceLogging: applyExtraction', result.intent, 'callbacks:', !!updateQSOFn, !!handleFieldChangeFn)
  // Buffer if no callbacks available
  if (!updateQSOFn && !handleFieldChangeFn) {
    console.log('VoiceLogging: No callbacks, buffering result. Pending:', pendingResults.length + 1)
    pendingResults.push(result)
    if (pendingResults.length > 5) pendingResults.shift() // cap buffer
    return
  }

  if (result.intent === 'noise') return

  // Drop operator's own callsign — never log yourself
  if (result.callsign && sessionContext.operatorCall &&
      result.callsign.toUpperCase() === sessionContext.operatorCall.toUpperCase()) {
    console.log('VoiceLogging: Dropping operator callsign from extraction:', result.callsign)
    result.callsign = ''
  }

  if (result.intent === 'new_qso') {
    if (result.callsign) {
      // Different callsign while we have an existing QSO → auto-submit first
      if (sessionContext.currentQSOCall &&
          sessionContext.currentQSOCall !== result.callsign.toUpperCase() &&
          onSubmitFn && !submitCooldownActive) {
        doSubmit()
        // Populate new QSO after submit settles
        setTimeout(() => populateQSO(result), 300)
        return
      }

      populateQSO(result)
    }

    if (result.submit && onSubmitFn && !submitCooldownActive) {
      doSubmit()
    }
  }

  if (result.intent === 'correction') {
    applyCorrectionResult(result)
  }

  if (result.intent === 'log_correction') {
    applyLogCorrection(result)
  }

  if (result.intent === 'session_update') {
    applySessionUpdate(result)
  }
}

function populateQSO (result) {
  const callUpper = result.callsign?.toUpperCase()

  // Callsign — use handleFieldChange to trigger lookup pipeline
  // Always update if different (even if we had one before — later extractions are more accurate)
  if (callUpper && !lockedFields.has('theirCall') && handleFieldChangeFn) {
    if (callUpper !== lastWrittenValues.theirCall) {
      handleFieldChangeFn({ fieldId: 'theirCall', value: callUpper })
      lastWrittenValues.theirCall = callUpper
    }
    sessionContext.currentQSOCall = callUpper
  }

  // RST sent (what operator told them) → our.sent column
  // Only update if non-empty and different from current value
  if (result.rst_sent && !lockedFields.has('ourSent') && updateQSOFn) {
    if (result.rst_sent !== lastWrittenValues.ourSent) {
      updateQSOFn({ our: { sent: result.rst_sent } })
      lastWrittenValues.ourSent = result.rst_sent
    }
  }

  // RST received (what they told operator) → their.sent column
  if (result.rst_rcvd && !lockedFields.has('theirSent') && updateQSOFn) {
    if (result.rst_rcvd !== lastWrittenValues.theirSent) {
      updateQSOFn({ their: { sent: result.rst_rcvd } })
      lastWrittenValues.theirSent = result.rst_rcvd
    }
  }

  // State — only set, never blank out an existing value
  if (result.state && !lockedFields.has('state') && handleFieldChangeFn) {
    const stateUpper = result.state.toUpperCase()
    if (stateUpper !== lastWrittenValues.state) {
      handleFieldChangeFn({ fieldId: 'state', value: stateUpper })
      lastWrittenValues.state = stateUpper
    }
  }
}

function applyCorrectionResult (result) {
  if (!result.correction_field || !result.correction_value) return

  const field = result.correction_field.toLowerCase()
  const value = result.correction_value

  if (field === 'callsign' && handleFieldChangeFn) {
    handleFieldChangeFn({ fieldId: 'theirCall', value: value.toUpperCase() })
    lastWrittenValues.theirCall = value.toUpperCase()
    sessionContext.currentQSOCall = value.toUpperCase()
  } else if (field === 'rst_sent' && updateQSOFn) {
    updateQSOFn({ our: { sent: value } })
    lastWrittenValues.ourSent = value
  } else if (field === 'rst_rcvd' && updateQSOFn) {
    updateQSOFn({ their: { sent: value } })
    lastWrittenValues.theirSent = value
  }
}

function applySessionUpdate (result) {
  if (!changeVFOFn) {
    console.log('VoiceLogging: session_update no changeVFO callback')
    return
  }

  const update = {}
  if (result.frequency) update.freq = parseFloat(result.frequency)
  if (result.band) update.band = result.band
  if (result.mode) update.mode = result.mode.toUpperCase()

  if (Object.keys(update).length === 0) return

  console.log('VoiceLogging: session_update applying:', JSON.stringify(update))
  changeVFOFn(update)
  lastStatus = `VFO: ${result.frequency ? result.frequency + ' MHz' : result.band || result.mode}`
  notifyListeners()
}

function applyLogCorrection (result) {
  const searchCall = result.search_call?.toUpperCase()
  if (!searchCall) {
    console.log('VoiceLogging: log_correction missing search_call')
    return
  }

  // Check if the search_call matches the current QSO being edited
  if (sessionContext.currentQSOCall === searchCall) {
    console.log('VoiceLogging: log_correction matches current QSO, applying inline')
    // Apply corrections to the current QSO using existing mechanisms
    const corrections = {}
    if (result.callsign) corrections.callsign = result.callsign
    if (result.rst_sent) corrections.rst_sent = result.rst_sent
    if (result.rst_rcvd) corrections.rst_rcvd = result.rst_rcvd
    if (result.state) corrections.state = result.state
    populateQSO({ ...corrections, intent: 'new_qso' })
    lastStatus = `fixed current: ${searchCall}`
    notifyListeners()
    return
  }

  // Otherwise, correct an already-submitted log entry
  if (!correctLogEntryFn) {
    console.log('VoiceLogging: log_correction no callback available')
    return
  }

  const corrections = {}
  if (result.callsign) corrections.theirCall = result.callsign.toUpperCase()
  if (result.rst_sent) corrections.ourSent = result.rst_sent
  if (result.rst_rcvd) corrections.theirSent = result.rst_rcvd
  if (result.state) corrections.state = result.state.toUpperCase()

  console.log('VoiceLogging: log_correction searching for', searchCall, 'corrections:', JSON.stringify(corrections))
  const success = correctLogEntryFn(searchCall, corrections)
  lastStatus = success ? `fixed: ${searchCall}` : `not found: ${searchCall}`
  notifyListeners()
}

function doSubmit () {
  if (!onSubmitFn || submitCooldownActive) return

  // Track the completed QSO
  if (sessionContext.currentQSOCall) {
    sessionContext.recentQSOs = [
      { callsign: sessionContext.currentQSOCall },
      ...sessionContext.recentQSOs
    ].slice(0, 3)
  }

  onSubmitFn()
  sessionContext.currentQSOCall = ''
  clearLocks()
  lastRegexCallsign = ''
  lastRegexRST = ''
  lastRegexState = ''
  cwTextBuffer = ''

  // Cooldown to prevent double-submit
  submitCooldownActive = true
  submitCooldownTimer = setTimeout(() => {
    submitCooldownActive = false
  }, 2000)
}

// --- CW regex pre-extraction (instant, no API call) ---
// Only handles RST reports — the one pattern regex does reliably.
// Callsigns, states, and submit are left to GPT which has full context.

// RST pattern: 3-char report starting with 4 or 5, may contain cut numbers (N=9, T=0)
const RST_RE = /\b([45][0-9NT][0-9NT])\b/g

function expandCutNumbers (rst) {
  return rst.replace(/N/g, '9').replace(/T/g, '0').replace(/A/g, '1').replace(/U/g, '2').replace(/V/g, '3').replace(/B/g, '7').replace(/D/g, '8')
}

function cwRegexPreExtract (buffer) {
  const raw = buffer.toUpperCase()

  // Collapse single-char tokens: "5 5 N" → "55N"
  const collapsed = raw.replace(/\b(\S)\s+(?=\S\b)/g, '$1')

  // Find RST reports
  const rsts = []
  let m
  RST_RE.lastIndex = 0
  while ((m = RST_RE.exec(collapsed)) !== null) {
    rsts.push(expandCutNumbers(m[1]))
  }

  if (rsts.length === 0) return null

  const rst_sent = rsts[0]
  const rst_rcvd = rsts.length >= 2 ? rsts[1] : rsts[0]

  return { intent: 'new_qso', callsign: '', rst_sent, rst_rcvd, state: '', submit: false }
}

let lastRegexRST = ''

function tryCWRegexExtraction () {
  if (!cwTextBuffer.trim()) return

  const result = cwRegexPreExtract(cwTextBuffer)
  if (!result) return

  if (result.rst_sent && result.rst_sent !== lastRegexRST) {
    console.log('VoiceLogging CW regex: instant RST:', result.rst_sent)
    lastRegexRST = result.rst_sent
    applyExtraction(result)
  }
}

// --- CW pipeline ---
let cwAudioChunkCount = 0
function handleCWAudioChunk (base64Pcm) {
  cwAudioChunkCount++
  if (cwAudioChunkCount <= 3 || cwAudioChunkCount % 100 === 0) {
    console.log('VoiceLogging CW: feedAudio chunk #' + cwAudioChunkCount + ' len=' + base64Pcm.length)
  }
  // Feed raw PCM directly to ggmorse — it decodes and emits events
  GGMorse.feedAudio(base64Pcm)
}

// Max WPM threshold — decodes above this are noise from ggmorse false triggers
const CW_MAX_WPM = 28
// Max cost function — higher means worse decode confidence (ggmorse uses < 1.0 internally)
const CW_MAX_COST = 0.7

function handleCWText (text) {
  if (!text) return
  // Filter out noise: high WPM readings are false triggers, not real CW
  if (cwLastWPM > CW_MAX_WPM) {
    console.log('VoiceLogging CW: filtered wpm=' + Math.round(cwLastWPM) + ':', text)
    return
  }
  // Filter low-confidence decodes — cost > threshold means poor timing match
  if (cwLastCost > CW_MAX_COST) {
    console.log('VoiceLogging CW: filtered cost=' + cwLastCost.toFixed(2) + ':', text)
    return
  }

  // Strip non-CW characters — ggmorse can emit newlines and other garbage
  const cleaned = text.replace(/[^A-Za-z0-9/?. -]/g, '')
  if (!cleaned) return
  console.log('VoiceLogging CW: decoded (cost=' + cwLastCost.toFixed(2) + ' wpm=' + Math.round(cwLastWPM) + '):', cleaned)

  cwTextBuffer += cleaned
  lastTranscript = cwTextBuffer.slice(-80) // show last 80 chars
  notifyListeners()

  // Instant regex pre-extraction — populate fields as soon as patterns emerge
  tryCWRegexExtraction()

  // Debounce GPT extraction — refines/corrects what regex found
  if (cwExtractionTimer) clearTimeout(cwExtractionTimer)
  cwExtractionTimer = setTimeout(() => runCWExtraction(), 1500)
}

async function runCWExtraction () {
  // Need at least 3 non-space chars to attempt extraction — single chars produce garbage
  if (!cwTextBuffer.trim() || cwTextBuffer.replace(/\s/g, '').length < 3 || pipelineBusy) return

  pipelineBusy = true
  setState('processing')

  // Only send last 200 chars to avoid context overflow
  const textForExtraction = cwTextBuffer.slice(-200).trim()
  console.log('VoiceLogging CW: extracting from:', JSON.stringify(textForExtraction))

  try {
    // Use GPT-4o-mini for CW extraction (better domain knowledge than on-device LLM)
    const result = await extractCW(textForExtraction, apiKey, sessionContext)
    console.log('VoiceLogging CW: extraction result:', JSON.stringify(result))
    if (result && result.intent !== 'noise') {
      lastStatus = `${result.intent}: ${result.callsign || '...'}`
      applyExtraction(result)
    }
    // Always clear buffer after extraction to avoid reprocessing
    cwTextBuffer = ''
  } catch (err) {
    console.log('VoiceLogging CW: extraction error:', err.message)
    lastStatus = `error: ${err.message}`
    cwTextBuffer = '' // clear on error too
  } finally {
    pipelineBusy = false
    if (state !== 'paused' && state !== 'idle') {
      setState('listening')
    }
  }
}

let cwLastWPM = 0
let cwLastCost = 0
function handleCWStats (stats) {
  if (stats.pitch > 0 && stats.wpm > 0) {
    cwLastWPM = stats.wpm
    cwLastCost = stats.cost || 0
    lastStatus = `CW: ${Math.round(stats.pitch)} Hz / ${Math.round(stats.wpm)} WPM / cost=${stats.cost?.toFixed(2)}`
    notifyListeners()
  }
}

function isCWMode () {
  const mode = (sessionContext.mode || '').toUpperCase()
  return mode === 'CW' || mode === 'CWR'
}

// --- Session lifecycle ---
export function startSession (key) {
  if (state === 'listening' || state === 'processing') return

  apiKey = key

  if (isCWMode()) {
    startCWSession()
  } else {
    startSSBSession()
  }
}

function startSSBSession () {
  if (!apiKey) {
    setState('error')
    lastStatus = 'no API key'
    return
  }

  recorder = createChunkedRecorder({
    onChunk: handleChunk,
    onSilence: handleSilence
  })

  recorder.start().then(started => {
    if (started) {
      setState('listening')
      lastStatus = 'listening (SSB)'
    } else {
      setState('error')
      lastStatus = 'mic permission denied'
    }
  })
}

async function startCWSession () {
  cwTextBuffer = ''

  if (!apiKey) {
    setState('error')
    lastStatus = 'no API key'
    return
  }

  // Start ggmorse decoder
  const started = await GGMorse.startDecoder(16000)
  if (!started) {
    setState('error')
    lastStatus = 'ggmorse init failed'
    return
  }

  // Subscribe to decoded text and stats events
  cwUnsubText = GGMorse.onText(handleCWText)
  cwUnsubStats = GGMorse.onStats(handleCWStats)

  // Start streaming recorder — feeds raw PCM to ggmorse
  recorder = createStreamingRecorder({
    onData: handleCWAudioChunk
  })

  const micStarted = await recorder.start()
  if (micStarted) {
    lastStatus = 'listening (CW)'
    setState('listening')
  } else {
    await GGMorse.stopDecoder()
    setState('error')
    lastStatus = 'mic permission denied'
  }
}

export function stopSession () {
  if (recorder) {
    recorder.stop()
    recorder = null
  }

  // Clean up CW resources
  if (cwUnsubText) { cwUnsubText(); cwUnsubText = null }
  if (cwUnsubStats) { cwUnsubStats(); cwUnsubStats = null }
  if (cwExtractionTimer) { clearTimeout(cwExtractionTimer); cwExtractionTimer = null }
  cwTextBuffer = ''
  GGMorse.stopDecoder()
  // Note: we keep the LLM model loaded to avoid re-download/reload on resume

  pipelineBusy = false
  sessionContext.currentQSOCall = ''
  clearLocks()
  pendingResults = []
  if (submitCooldownTimer) clearTimeout(submitCooldownTimer)
  submitCooldownActive = false
  setState('idle')
  lastStatus = ''
  lastTranscript = ''
}

export function pauseSession () {
  if (recorder && (state === 'listening' || state === 'processing')) {
    recorder.pause()
    setState('paused')
    lastStatus = 'paused'
  }
}

export function resumeSession () {
  if (recorder && state === 'paused') {
    recorder.resume()
    setState('listening')
    lastStatus = 'listening'
  }
}

export function toggleSession (key) {
  if (state === 'idle') {
    startSession(key)
  } else if (state === 'paused') {
    resumeSession()
  } else {
    pauseSession()
  }
}
