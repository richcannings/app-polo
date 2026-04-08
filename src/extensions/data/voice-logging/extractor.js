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
- "correction": the operator is correcting a previously stated value
- "session_update": band/mode/frequency change
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
        enum: ['new_qso', 'correction', 'session_update', 'noise']
      },
      callsign: { type: 'string' },
      rst_sent: { type: 'string' },
      rst_rcvd: { type: 'string' },
      state: { type: 'string' },
      correction_field: { type: 'string' },
      correction_value: { type: 'string' },
      confidence: { type: 'number' },
      submit: { type: 'boolean' }
    },
    required: ['intent', 'callsign', 'rst_sent', 'rst_rcvd', 'state', 'correction_field', 'correction_value', 'confidence', 'submit']
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
