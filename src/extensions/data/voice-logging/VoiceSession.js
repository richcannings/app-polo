/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createChunkedRecorder, createStreamingRecorder } from './audio'
import { transcribeAudio } from './whisper'
import { extractQSO } from './extractor'
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
  listeners.forEach(fn => {
    try { fn({ state, lastTranscript, lastStatus }) } catch (e) { /* ignore */ }
  })
}

export function subscribe (fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter(l => l !== fn) }
}

export function getState () {
  return { state, lastTranscript, lastStatus }
}

// --- Callbacks ---
export function setCallbacks ({ updateQSO, onSubmitEditing, handleFieldChange }) {
  console.log('VoiceLogging: setCallbacks', !!updateQSO, !!onSubmitEditing, !!handleFieldChange)
  updateQSOFn = updateQSO
  onSubmitFn = onSubmitEditing
  handleFieldChangeFn = handleFieldChange

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
}

function populateQSO (result) {
  const callUpper = result.callsign?.toUpperCase()

  // Callsign — use handleFieldChange to trigger lookup pipeline
  if (callUpper && !lockedFields.has('theirCall')) {
    if (handleFieldChangeFn) {
      handleFieldChangeFn({ fieldId: 'theirCall', value: callUpper })
      lastWrittenValues.theirCall = callUpper
      sessionContext.currentQSOCall = callUpper
    }
  }

  // RST sent (what operator told them) → our.sent column
  if (result.rst_sent && !lockedFields.has('ourSent') && updateQSOFn) {
    updateQSOFn({ our: { sent: result.rst_sent } })
    lastWrittenValues.ourSent = result.rst_sent
  }

  // RST received (what they told operator) → their.sent column
  if (result.rst_rcvd && !lockedFields.has('theirSent') && updateQSOFn) {
    updateQSOFn({ their: { sent: result.rst_rcvd } })
    lastWrittenValues.theirSent = result.rst_rcvd
  }

  // State
  if (result.state && !lockedFields.has('state') && handleFieldChangeFn) {
    handleFieldChangeFn({ fieldId: 'state', value: result.state.toUpperCase() })
    lastWrittenValues.state = result.state.toUpperCase()
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

  // Cooldown to prevent double-submit
  submitCooldownActive = true
  submitCooldownTimer = setTimeout(() => {
    submitCooldownActive = false
  }, 2000)
}

// --- CW pipeline ---
function handleCWAudioChunk (base64Pcm) {
  // Feed raw PCM directly to ggmorse — it decodes and emits events
  GGMorse.feedAudio(base64Pcm)
}

function handleCWText (text) {
  if (!text) return
  console.log('VoiceLogging CW: decoded:', text)

  cwTextBuffer += text
  lastTranscript = cwTextBuffer.slice(-80) // show last 80 chars
  notifyListeners()

  // Debounce extraction — wait for a pause in decoded text before running LLM
  if (cwExtractionTimer) clearTimeout(cwExtractionTimer)
  cwExtractionTimer = setTimeout(() => runCWExtraction(), 3000)
}

async function runCWExtraction () {
  if (!cwTextBuffer.trim() || pipelineBusy) return

  pipelineBusy = true
  setState('processing')

  try {
    const result = await CWExtractor.extractCW(cwTextBuffer, sessionContext)
    if (result && result.intent !== 'noise') {
      lastStatus = `${result.intent}: ${result.callsign || '...'}`
      applyExtraction(result)

      // Clear buffer after successful extraction with a submit
      if (result.submit) {
        cwTextBuffer = ''
      }
    }
  } catch (err) {
    console.log('VoiceLogging CW: extraction error:', err.message)
    lastStatus = `error: ${err.message}`
  } finally {
    pipelineBusy = false
    if (state !== 'paused' && state !== 'idle') {
      setState('listening')
    }
  }
}

function handleCWStats (stats) {
  if (stats.pitch > 0 && stats.wpm > 0) {
    lastStatus = `CW: ${Math.round(stats.pitch)} Hz / ${Math.round(stats.wpm)} WPM`
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

  // Initialize LLM model for CW extraction
  lastStatus = 'loading CW model...'
  notifyListeners()
  const modelReady = await CWExtractor.initModel((progress) => {
    if (progress < 1) {
      lastStatus = `downloading model: ${Math.round(progress * 100)}%`
    } else {
      lastStatus = 'loading model...'
    }
    notifyListeners()
  })
  if (!modelReady) {
    setState('error')
    lastStatus = 'CW model failed to load'
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
    setState('listening')
    lastStatus = 'listening (CW)'
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
