/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const SYSTEM_PROMPT = `You are an expert ham radio operator listening to a live transcript of a Parks on the Air (POTA) activation.
Your task is to extract QSO data from the transcript in real time.

IMPORTANT: The transcript comes from speech-to-text and may contain errors, misspellings, or garbled phonetics. You must interpret what was MEANT, not just what was literally transcribed. For example, "Fox Trotter Delta" likely means "Foxtrot Delta" (FD), and "P-P-P-P-Tango" likely means a repeated letter attempt.

Extract these fields when heard. ALWAYS convert to standard short form:
- callsign: the OTHER station's callsign (NOT the operator's own callsign). Must be in standard alphanumeric form (e.g. "K2MAB" not "Kilo 2 Mike Alpha Bravo"). Amateur callsigns follow the pattern: 1-2 letters + 1 digit + 1-3 letters (e.g. W1AW, K2MAB, AD6FD, N4TPT). If you cannot determine a valid callsign, return empty string "". NEVER return partial callsigns, numbers only, or the operator's own call.
- rst_sent: the signal report the OPERATOR gives TO the other station (what the operator tells them their signal sounds like). As digits only (e.g. "59" not "five nine"). This is logged in the "Sent" column.
- rst_rcvd: the signal report the OTHER station gives BACK TO the operator (what they tell the operator their signal sounds like). As digits only. This is logged in the "Rcvd" column.
- state: US state as 2-letter abbreviation (e.g. "CA" not "California", "MO" not "Missouri")
- intent: classify what's happening in the transcript
- submit: true if the operator says QSL, log it, 73, or clearly ends the QSO

Intent types:
- "new_qso": ANY indication of a contact — callsign exchange, signal reports, phonetic letters that look like a callsign attempt, even if garbled. When in doubt between "new_qso" and "noise", prefer "new_qso" if there are ANY phonetic alphabet words that could be a callsign.
- "correction": the operator is correcting a previously stated value in the CURRENT QSO being logged
- "log_correction": the operator says "Polo" followed by a correction command for a PREVIOUSLY LOGGED entry. The trigger word is "Polo" (or "polo", "pollo", "polo please", etc). Examples:
  - "Polo, fix K6AB, it should be K6ABC" → search_call="K6AB", callsign="K6ABC"
  - "Polo, correct the entry for Whiskey Delta Four Mike Sierra Mike, the state should be Alabama" → search_call="WD4MSM", state="AL"
  - "Polo, K6AB callsign should be K6ABC and state California" → search_call="K6AB", callsign="K6ABC", state="CA"
  - "Polo, fix November Two Yankee Charlie, signal report should be five seven nine" → search_call="N2YC", rst_sent="579"
  The search_call is the callsign CURRENTLY in the log that needs to be found. The other fields are the CORRECTED values to apply.
- "session_update": the operator says "Polo" followed by a frequency, band, or mode change. Examples:
  - "Polo, we are now on 14.314 MHz" → frequency="14.314"
  - "Polo, transmitting on 7.255" → frequency="7.255"
  - "Polo, moving to 40 meters" → band="40m"
  - "Polo, switching to CW" → mode="CW"
  The frequency field should be in MHz as a decimal string (e.g. "14.314", "7.255", "146.520").
- "noise": ONLY use this when the transcript is truly unintelligible or contains no ham radio content at all (e.g. casual conversation, background noise)

ITU Phonetic Alphabet (transcript may use misspellings or alternate forms):
Alpha/Alfa, Bravo, Charlie, Delta, Echo, Foxtrot (may appear as "Fox Trot", "Fox Trotter"), Golf, Hotel, India, Juliet, Kilo, Lima, Mike, November, Oscar, Papa, Quebec, Romeo, Sierra, Tango, Uniform, Victor, Whiskey, X-Ray/Xray, Yankee, Zulu.

Numbers: zero/oh/0, one/1, two/too/to/2, three/tree/3, four/4, five/fife/5, six/6, seven/7, eight/8, nine/niner/9.

Return ONLY valid JSON. No extra text.`

const JSON_SCHEMA = {
  name: 'voice_logging_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        enum: ['new_qso', 'correction', 'log_correction', 'session_update', 'noise']
      },
      callsign: { type: 'string' },
      search_call: { type: 'string' },
      rst_sent: { type: 'string' },
      rst_rcvd: { type: 'string' },
      state: { type: 'string' },
      frequency: { type: 'string' },
      band: { type: 'string' },
      mode: { type: 'string' },
      correction_field: { type: 'string' },
      correction_value: { type: 'string' },
      confidence: { type: 'number' },
      submit: { type: 'boolean' }
    },
    required: ['intent', 'callsign', 'search_call', 'rst_sent', 'rst_rcvd', 'state', 'frequency', 'band', 'mode', 'correction_field', 'correction_value', 'confidence', 'submit']
  }
}

export function buildUserPrompt (transcript, context = {}) {
  const lines = []

  if (context.operatorCall) {
    lines.push(`Operator's own callsign: ${context.operatorCall} — DO NOT extract this as the other station's callsign. Any mention of "${context.operatorCall}" or its phonetic equivalent in the transcript is the operator identifying themselves.`)
  }
  if (context.band) lines.push(`Band: ${context.band}`)
  if (context.mode) lines.push(`Mode: ${context.mode}`)
  if (context.currentQSOCall) lines.push(`Current QSO in progress with: ${context.currentQSOCall}`)

  if (context.recentQSOs && context.recentQSOs.length > 0) {
    const recent = context.recentQSOs.map(q => q.callsign).join(', ')
    lines.push(`Recent QSOs (already logged, do not re-extract): ${recent}`)
  }

  lines.push('')
  lines.push(`Transcript:\n${transcript}`)

  return lines.join('\n')
}

export async function extractQSO (transcript, apiKey, context = {}) {
  const userPrompt = buildUserPrompt(transcript, context)

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: JSON_SCHEMA.name,
          schema: JSON_SCHEMA.schema,
          strict: true
        }
      }
    })
  })

  if (!response.ok) {
    const body = await response.text()
    console.log('VoiceLogging: GPT API error', response.status, body)
    throw new Error(`GPT API error ${response.status}`)
  }

  const result = await response.json()
  const content = result.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('GPT response missing content')
  }

  const parsed = JSON.parse(content)
  console.log('VoiceLogging: Extracted:', JSON.stringify(parsed))
  return parsed
}

// --- CW extraction via GPT-4o-mini ---

const CW_SYSTEM_PROMPT = `You are an expert CW (Morse code) operator analyzing decoded Morse code text from a POTA/SOTA ham radio activation.

The input comes from an automated Morse decoder (ggmorse) and contains errors:
- Extra or missing spaces between characters
- Misidentified dots/dashes causing wrong letters (e.g. V↔N, M↔T, G↔W)
- Split words (e.g. "W 1 A A X" should be "W1AAX")
- Noise characters: isolated E, I, T, S between valid words (single dot/dash artifacts)
- Repeated content (operators repeat for clarity)
- CW cut numbers in RST reports: A=1, U=2, V=3, 4=4, 5=5, 6=6, B=7, D=8, N=9, T=0
  Examples: "5NN" = "599", "55N" = "559", "33N" = "339", "5NT" = "590"

Your job is to reconstruct the intended ham radio exchange like an experienced CW operator would.

The operator's own callsign will be provided — do NOT extract it as the other station.

Common CW exchange patterns:
- CQ POTA [activator call] [activator call]
- [hunter call] [hunter call]
- [hunter call] GM/GA/GE UR [RST] [RST] [state] BK
- BK UR [RST] [RST] [state] BK
- TU 73 EE / TU 72 EE (end of QSO)
- DE [call] = "from [call]"

Extract ONLY the OTHER station's data (not the operator's own callsign or the operator's own RST).

Important rules:
- Callsigns follow the pattern: 1-2 letters + digit + 1-3 letters (e.g. K1RI, W3AAX, KB4NU)
- When reconstructing a callsign from noisy decode, consider common CW confusions and pick the most likely valid callsign
- ALWAYS expand cut numbers in RST: N→9, T→0, A→1, U→2, V→3, B→7, D→8
- RST reports are typically 3 digits (e.g. 599, 559, 579). "5NN" = 599, "55N" = 559
- 73 = best regards (end of QSO), 72 = QRP best regards
- If you see QSO data (callsign fragments, RST, BK), classify as "new_qso" not "noise"
- Prefer returning partial data over classifying as noise`

const CW_JSON_SCHEMA = {
  name: 'cw_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        enum: ['new_qso', 'correction', 'noise']
      },
      callsign: { type: 'string' },
      rst_sent: { type: 'string' },
      rst_rcvd: { type: 'string' },
      state: { type: 'string' },
      park_ref: { type: 'string' },
      summit_ref: { type: 'string' },
      submit: { type: 'boolean' },
      confidence: { type: 'number' }
    },
    required: ['intent', 'callsign', 'rst_sent', 'rst_rcvd', 'state', 'park_ref', 'summit_ref', 'submit', 'confidence']
  }
}

function buildCWUserPrompt (decodedText, context = {}) {
  const lines = []
  if (context.operatorCall) {
    lines.push(`Operator's own callsign: ${context.operatorCall} (do NOT extract this)`)
  }
  if (context.currentQSOCall) {
    lines.push(`Current QSO in progress with: ${context.currentQSOCall}`)
  }
  if (context.recentQSOs && context.recentQSOs.length > 0) {
    const recent = context.recentQSOs.map(q => q.callsign).join(', ')
    lines.push(`Recently logged: ${recent}`)
  }
  lines.push('')
  lines.push(`Decoded CW text:\n${decodedText}`)
  return lines.join('\n')
}

export async function extractCW (decodedText, apiKey, context = {}) {
  const userPrompt = buildCWUserPrompt(decodedText, context)

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: CW_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: CW_JSON_SCHEMA.name,
          schema: CW_JSON_SCHEMA.schema,
          strict: true
        }
      }
    })
  })

  if (!response.ok) {
    const body = await response.text()
    console.log('VoiceLogging: CW GPT API error', response.status, body)
    throw new Error(`CW GPT API error ${response.status}`)
  }

  const result = await response.json()
  const content = result.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('CW GPT response missing content')
  }

  const parsed = JSON.parse(content)
  console.log('VoiceLogging CW: GPT Extracted:', JSON.stringify(parsed))
  return parsed
}
