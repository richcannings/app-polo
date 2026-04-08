/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import KeepAwake from '@sayem314/react-native-keep-awake'

import * as VoiceSession from './VoiceSession'

// --- Control (InputComponent) ---
// Mounts when user taps Voice chip. Auto-starts voice session.
// Bridges VoiceSession to PoLo's updateQSO/onSubmitEditing/handleFieldChange.
export function VoiceLoggingControl (props) {
  const { style, styles, settings, qso, operation, vfo, updateQSO, onSubmitEditing, handleFieldChange } = props
  const [sessionState, setSessionState] = useState(VoiceSession.getState())

  const apiKey = settings?.accounts?.voiceLogging?.apiKey

  // Subscribe to VoiceSession state
  useEffect(() => {
    return VoiceSession.subscribe(setSessionState)
  }, [])

  // Bridge callbacks to VoiceSession
  useEffect(() => {
    console.log('VoiceLogging: Setting callbacks', !!updateQSO, !!onSubmitEditing, !!handleFieldChange)
    VoiceSession.setCallbacks({ updateQSO, onSubmitEditing, handleFieldChange })
    return () => VoiceSession.clearCallbacks()
  }, [updateQSO, onSubmitEditing, handleFieldChange])

  // Auto-start voice session on mount
  useEffect(() => {
    if (apiKey && sessionState.state === 'idle') {
      console.log('VoiceLogging: Auto-starting session')
      VoiceSession.startSession(apiKey)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update session context when operation/QSO changes
  useEffect(() => {
    VoiceSession.setSessionContext({
      operatorCall: operation?.stationCall || '',
      band: vfo?.band || operation?.local?.band || '',
      mode: vfo?.mode || operation?.local?.mode || ''
    })
  }, [operation, vfo])

  // Field locking: detect touch edits by comparing qso against last written values
  useEffect(() => {
    if (!qso) return
    const lastWritten = VoiceSession.getLastWrittenValues()

    if (qso.their?.call && lastWritten.theirCall && qso.their.call !== lastWritten.theirCall) {
      VoiceSession.lockField('theirCall')
    }
    if (qso.their?.sent && lastWritten.theirSent && qso.their.sent !== lastWritten.theirSent) {
      VoiceSession.lockField('theirSent')
    }
    if (qso.our?.sent && lastWritten.ourSent && qso.our.sent !== lastWritten.ourSent) {
      VoiceSession.lockField('ourSent')
    }
  }, [qso?.their?.call, qso?.their?.sent, qso?.our?.sent])

  const isActive = sessionState.state === 'listening' || sessionState.state === 'processing'

  const statusLabel = sessionState.state === 'processing' ? 'Processing...'
    : isActive ? 'Listening'
    : sessionState.state === 'paused' ? 'Paused'
    : sessionState.state === 'error' ? 'Error'
    : sessionState.state

  return (
    <View style={[style, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
      {isActive && <KeepAwake />}
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#222', fontSize: 11 }} numberOfLines={1}>
          {sessionState.lastStatus || statusLabel}
        </Text>
        {sessionState.lastTranscript ? (
          <Text style={{ color: '#555', fontSize: 10, marginTop: 2 }} numberOfLines={2}>
            {sessionState.lastTranscript}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
