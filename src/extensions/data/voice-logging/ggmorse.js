/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { NativeModules, NativeEventEmitter } from 'react-native'

const { GGMorseModule } = NativeModules

let emitter = null
let textSubscription = null
let statsSubscription = null

function getEmitter () {
  if (!emitter && GGMorseModule) {
    emitter = new NativeEventEmitter(GGMorseModule)
  }
  return emitter
}

export async function startDecoder (sampleRate = 16000) {
  if (!GGMorseModule) {
    console.log('GGMorse: Native module not available')
    return false
  }
  try {
    const result = await GGMorseModule.startDecoder(sampleRate)
    console.log('GGMorse: Decoder started:', result)
    return result
  } catch (err) {
    console.log('GGMorse: startDecoder error:', err.message)
    return false
  }
}

export async function feedAudio (base64Pcm) {
  if (!GGMorseModule) return ''
  try {
    return await GGMorseModule.feedAudio(base64Pcm)
  } catch (err) {
    return ''
  }
}

export async function stopDecoder () {
  if (!GGMorseModule) return
  try {
    await GGMorseModule.stopDecoder()
    console.log('GGMorse: Decoder stopped')
  } catch (err) {
    console.log('GGMorse: stopDecoder error:', err.message)
  }
}

export function onText (callback) {
  const em = getEmitter()
  if (!em) return () => {}
  if (textSubscription) textSubscription.remove()
  textSubscription = em.addListener('onMorseText', (event) => {
    callback(event.text)
  })
  return () => {
    if (textSubscription) {
      textSubscription.remove()
      textSubscription = null
    }
  }
}

export function onStats (callback) {
  const em = getEmitter()
  if (!em) return () => {}
  if (statsSubscription) statsSubscription.remove()
  statsSubscription = em.addListener('onMorseStats', (event) => {
    callback(event)
  })
  return () => {
    if (statsSubscription) {
      statsSubscription.remove()
      statsSubscription = null
    }
  }
}
