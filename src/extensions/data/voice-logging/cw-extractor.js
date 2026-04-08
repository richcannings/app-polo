/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// CW QSO Extractor using on-device LLM (llama.rn + Qwen2.5-1.5B)
// Decodes noisy ggmorse output into structured QSO fields

import { initLlama } from 'llama.rn'
import ReactNativeBlobUtil from 'react-native-blob-util'

const MODEL_FILENAME = 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
const MODEL_URL = 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf'

const SYSTEM_PROMPT = `You are an expert CW (Morse code) operator analyzing decoded Morse code text from a POTA/SOTA ham radio activation.

The input comes from an automated Morse decoder and may contain errors:
- Extra or missing spaces between characters
- Misidentified dots/dashes causing wrong letters
- Split words (e.g. "W 3 A A X" should be "W3AAX")
- Repeated content (operators repeat for clarity)
- CW cut numbers: N=9, T=0 (e.g. "5NN" means "599", "33N" means "339")

Your job is to reconstruct the intended ham radio exchange and extract QSO data.

The operator's own callsign will be provided — do NOT extract it as the other station.

Common CW exchange pattern for POTA/SOTA:
- CQ POTA/SOTA [activator call]
- [hunter call]
- [hunter call] UR [RST] [RST] [state] BK
- BK UR [RST] [RST] [state] BK
- TU 73 E E

Extract ONLY the OTHER station's data (not the operator's own callsign, not the operator's own RST/state).

Fields:
- callsign: the OTHER station's callsign (standard format: 1-2 letters + digit + 1-3 letters, optional /P)
- rst_sent: the signal report the OPERATOR gives TO the other station (digits only, expand cut numbers)
- rst_rcvd: the signal report the OTHER station gives BACK to the operator (digits only, expand cut numbers)
- state: US state or Canadian province as 2-letter code
- park_ref: POTA park reference if mentioned (e.g. "K-1234")
- summit_ref: SOTA summit reference if mentioned (e.g. "W4G/NG-006")
- submit: true if the QSO is ending (73, TU, QSL heard)
- intent: "new_qso" if there's useful QSO data, "noise" if the text is unintelligible

Return empty strings for fields you cannot determine. Prefer returning partial data over nothing.`

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['new_qso', 'noise'] },
    callsign: { type: 'string' },
    rst_sent: { type: 'string' },
    rst_rcvd: { type: 'string' },
    state: { type: 'string' },
    park_ref: { type: 'string' },
    summit_ref: { type: 'string' },
    submit: { type: 'boolean' }
  },
  required: ['intent', 'callsign', 'rst_sent', 'rst_rcvd', 'state', 'park_ref', 'summit_ref', 'submit']
})

let llamaContext = null
let modelReady = false
let modelLoading = false

// Get the path where the model is stored
function getModelPath () {
  return `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${MODEL_FILENAME}`
}

// Check if model is downloaded
async function isModelDownloaded () {
  const path = getModelPath()
  return ReactNativeBlobUtil.fs.exists(path)
}

// Download the model file with progress reporting
export async function downloadModel (onProgress) {
  const path = getModelPath()
  const exists = await ReactNativeBlobUtil.fs.exists(path)
  if (exists) {
    console.log('CW-Extractor: Model already downloaded')
    if (onProgress) onProgress(1.0)
    return path
  }

  console.log('CW-Extractor: Downloading model...')
  if (onProgress) onProgress(0)

  const res = await ReactNativeBlobUtil.config({
    path,
    fileCache: true
  }).fetch('GET', MODEL_URL)
    .progress((received, total) => {
      if (onProgress && total > 0) {
        onProgress(received / total)
      }
    })

  console.log('CW-Extractor: Model downloaded to', res.path())
  return res.path()
}

// Initialize the LLM context
export async function initModel (onProgress) {
  if (modelReady && llamaContext) return true
  if (modelLoading) return false

  modelLoading = true
  try {
    // Ensure model is downloaded
    const modelPath = await downloadModel(onProgress)

    console.log('CW-Extractor: Loading model...')
    llamaContext = await initLlama({
      model: modelPath,
      n_ctx: 512,
      n_gpu_layers: 0,
      n_threads: 4
    }, (progress) => {
      console.log('CW-Extractor: Model load progress:', Math.round(progress * 100) + '%')
    })

    modelReady = true
    modelLoading = false
    console.log('CW-Extractor: Model loaded successfully')
    return true
  } catch (err) {
    console.log('CW-Extractor: Failed to load model:', err.message)
    modelLoading = false
    return false
  }
}

// Release the model
export async function releaseModel () {
  if (llamaContext) {
    await llamaContext.release()
    llamaContext = null
  }
  modelReady = false
  modelLoading = false
}

// Extract QSO data from decoded CW text
export async function extractCW (decodedText, context = {}) {
  if (!modelReady || !llamaContext) {
    console.log('CW-Extractor: Model not ready')
    return null
  }

  const userLines = []
  if (context.operatorCall) {
    userLines.push(`Operator's own callsign: ${context.operatorCall} (do NOT extract this)`)
  }
  if (context.currentQSOCall) {
    userLines.push(`Current QSO in progress with: ${context.currentQSOCall}`)
  }
  if (context.recentQSOs && context.recentQSOs.length > 0) {
    const recent = context.recentQSOs.map(q => q.callsign).join(', ')
    userLines.push(`Recently logged: ${recent}`)
  }
  userLines.push('')
  userLines.push(`Decoded CW text:\n${decodedText}`)

  const userPrompt = userLines.join('\n')

  try {
    const result = await llamaContext.completion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      n_predict: 128,
      temperature: 0,
      json_schema: JSON_SCHEMA
    })

    const parsed = JSON.parse(result.text)
    console.log('CW-Extractor: Extracted:', JSON.stringify(parsed))
    return parsed
  } catch (err) {
    console.log('CW-Extractor: Extraction error:', err.message)
    return null
  }
}

export function isReady () {
  return modelReady
}
