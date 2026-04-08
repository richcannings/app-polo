/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import ReactNativeBlobUtil from 'react-native-blob-util'

export async function transcribeAudio (wavFilePath, apiKey, context = {}) {
  const promptParts = [
    'Amateur ham radio POTA activation QSO in progress.'
  ]

  if (context.operatorCall) {
    promptParts.push(`Operator station: ${context.operatorCall}.`)
  }

  if (context.currentQSOCall) {
    promptParts.push(`Current QSO with: ${context.currentQSOCall}.`)
  }

  if (context.recentQSOs && context.recentQSOs.length > 0) {
    const recent = context.recentQSOs.map(q => q.callsign).join(', ')
    promptParts.push(`Recent contacts: ${recent}.`)
  }

  promptParts.push(
    'Callsigns follow amateur radio format: 1-2 letters, a digit, then 1-3 letters. Examples: W1AW, K2MAB, AD6FD, N4TPT, KI6NAZ, KB6VPR.',
    'ITU phonetic alphabet: Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet, Kilo, Lima, Mike, November, Oscar, Papa, Quebec, Romeo, Sierra, Tango, Uniform, Victor, Whiskey, X-ray, Yankee, Zulu.',
    'Signal reports like five nine (59), three four (34), five seven (57).',
    'QSL, 73, CQ, POTA, parks on the air.'
  )

  const prompt = promptParts.join(' ')

  const response = await ReactNativeBlobUtil.fetch(
    'POST',
    'https://api.openai.com/v1/audio/transcriptions',
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'multipart/form-data'
    },
    [
      { name: 'file', filename: 'audio.wav', type: 'audio/wav', data: ReactNativeBlobUtil.wrap(wavFilePath) },
      { name: 'model', data: 'whisper-1' },
      { name: 'language', data: 'en' },
      { name: 'prompt', data: prompt }
    ]
  )

  const status = response.respInfo.status
  if (status !== 200) {
    const body = response.text()
    console.log('VoiceLogging: Whisper API error', status, body)
    throw new Error(`Whisper API error ${status}: ${body}`)
  }

  const result = response.json()
  console.log('VoiceLogging: Whisper transcript:', result.text)
  return result.text
}
