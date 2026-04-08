/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Buffer } from 'buffer'
import { PermissionsAndroid, Platform } from 'react-native'
import LiveAudioStream from 'react-native-live-audio-stream'
import ReactNativeBlobUtil from 'react-native-blob-util'

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) // 32000
const CHUNK_DURATION_MS = 10000
const OVERLAP_DURATION_MS = 2000
const SILENCE_THRESHOLD_DB = -60

// Encode raw PCM base64 chunks into a WAV file and return the temp file path
export async function pcmChunksToWavFile (chunks, fileIndex = 0) {
  const buffers = chunks.map(chunk => Buffer.from(chunk, 'base64'))
  const pcmData = Buffer.concat(buffers)

  const byteRate = BYTES_PER_SECOND
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8)
  const dataSize = pcmData.length

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  const wavBuffer = Buffer.concat([header, pcmData])
  const wavBase64 = wavBuffer.toString('base64')

  const filePath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/voice-logging-chunk-${fileIndex % 3}.wav`
  await ReactNativeBlobUtil.fs.writeFile(filePath, wavBase64, 'base64')

  return filePath
}

// Check if PCM base64 chunks are below the silence threshold
export function isSilent (chunks) {
  let sumSquares = 0
  let sampleCount = 0

  for (const chunk of chunks) {
    const buf = Buffer.from(chunk, 'base64')
    for (let i = 0; i < buf.length - 1; i += 2) {
      const sample = buf.readInt16LE(i)
      sumSquares += sample * sample
      sampleCount++
    }
  }

  if (sampleCount === 0) return true

  const rms = Math.sqrt(sumSquares / sampleCount)
  const db = 20 * Math.log10(rms / 32768)
  return db < SILENCE_THRESHOLD_DB
}

async function requestMicPermission () {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    )
    return granted === PermissionsAndroid.RESULTS.GRANTED
  }
  return true
}

// Create a continuous chunked recorder that produces WAV files at regular intervals
// onChunk(wavFilePath) is called each time a non-silent chunk is ready
// onSilence() is called when a chunk is skipped due to silence
export function createChunkedRecorder ({ onChunk, onSilence }) {
  let buffer = []
  let overlapTail = []
  let chunkTimer = null
  let fileIndex = 0
  let isRunning = false

  // Calculate how many base64 data events correspond to the overlap duration
  // At 16kHz/16-bit/mono with ~4096 byte buffers, each callback is ~128ms
  // 2000ms overlap ≈ ~16 callbacks
  const overlapBytes = (OVERLAP_DURATION_MS / 1000) * BYTES_PER_SECOND
  const estimatedCallbackBytes = 4096 // approximate bytes per data callback
  const overlapCallbackCount = Math.ceil(overlapBytes / estimatedCallbackBytes)

  function onData (data) {
    if (isRunning) {
      buffer.push(data)
    }
  }

  async function emitChunk () {
    if (buffer.length === 0) return

    const currentChunks = [...overlapTail, ...buffer]
    // Save tail for overlap into next chunk
    overlapTail = buffer.slice(-overlapCallbackCount)
    buffer = []

    if (isSilent(currentChunks)) {
      if (onSilence) onSilence()
      return
    }

    try {
      const wavPath = await pcmChunksToWavFile(currentChunks, fileIndex++)
      if (onChunk) onChunk(wavPath)
    } catch (err) {
      console.log('VoiceLogging: Error creating WAV chunk:', err.message)
    }
  }

  async function start () {
    if (isRunning) return false

    const hasPermission = await requestMicPermission()
    if (!hasPermission) return false

    buffer = []
    overlapTail = []
    fileIndex = 0
    isRunning = true

    LiveAudioStream.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: 6
    })

    LiveAudioStream.on('data', onData)
    LiveAudioStream.start()

    chunkTimer = setInterval(emitChunk, CHUNK_DURATION_MS)
    console.log('VoiceLogging: Chunked recorder started')
    return true
  }

  function stop () {
    isRunning = false
    if (chunkTimer) {
      clearInterval(chunkTimer)
      chunkTimer = null
    }
    LiveAudioStream.stop()
    buffer = []
    overlapTail = []
    console.log('VoiceLogging: Chunked recorder stopped')
  }

  function pause () {
    isRunning = false
    if (chunkTimer) {
      clearInterval(chunkTimer)
      chunkTimer = null
    }
    LiveAudioStream.stop()
    console.log('VoiceLogging: Chunked recorder paused')
  }

  function resume () {
    if (isRunning) return
    isRunning = true

    LiveAudioStream.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: 6
    })

    LiveAudioStream.on('data', onData)
    LiveAudioStream.start()

    chunkTimer = setInterval(emitChunk, CHUNK_DURATION_MS)
    console.log('VoiceLogging: Chunked recorder resumed')
  }

  return { start, stop, pause, resume }
}

// Create a streaming recorder that forwards every PCM chunk directly (for CW/ggmorse)
// onData(base64PcmChunk) is called for each raw audio data event
export function createStreamingRecorder ({ onData: onDataCallback }) {
  let isRunning = false

  function onData (data) {
    if (isRunning && onDataCallback) {
      onDataCallback(data)
    }
  }

  async function start () {
    if (isRunning) return false

    const hasPermission = await requestMicPermission()
    if (!hasPermission) return false

    isRunning = true

    LiveAudioStream.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: 6
    })

    LiveAudioStream.on('data', onData)
    LiveAudioStream.start()
    console.log('VoiceLogging: Streaming recorder started (CW mode)')
    return true
  }

  function stop () {
    isRunning = false
    LiveAudioStream.stop()
    console.log('VoiceLogging: Streaming recorder stopped')
  }

  function pause () {
    isRunning = false
    LiveAudioStream.stop()
    console.log('VoiceLogging: Streaming recorder paused')
  }

  function resume () {
    if (isRunning) return
    isRunning = true

    LiveAudioStream.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: 6
    })

    LiveAudioStream.on('data', onData)
    LiveAudioStream.start()
    console.log('VoiceLogging: Streaming recorder resumed')
  }

  return { start, stop, pause, resume }
}
