/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import { useDispatch, useSelector } from 'react-redux'
import KeepAwake from '@sayem314/react-native-keep-awake'

import { selectQSOs, addQSO } from '../../../store/qsos'
import { setVFO } from '../../../store/station/stationSlice'
import * as VoiceSession from './VoiceSession'

// --- Tappable ticker tape parsing ---
// Match anywhere in the string — no word boundaries, since decoded CW is often one long run.

// US callsigns follow strict FCC patterns:
//   Group A (Extra): 1x2, 2x1 — e.g. K1RI, WC1N, AA1A
//   Group B (Advanced): 2x2 — e.g. KA1BB
//   Group C (General/Tech): 1x3, 2x3 — e.g. N4FPF, KN4DHW, WB3DDT
// Valid US prefixes: A[A-L], K, N, W
// Canadian callsigns: VE, VA, VY, VO, VX + digit + 1-3 letters — e.g. VE3TEF, VA3EKK
// Both matched first and treated equally above international calls
const US_CA_CALL_RE = /([AKNW][A-Z]?\d[A-Z]{1,3}(?:\/[A-Z0-9]+)?|V[AEOYXJ]\d[A-Z]{1,3}(?:\/[A-Z0-9]+)?)/g

// General international callsign: 1-2 letters + digit + 1-4 letters (catches VK, JA, DL, G, etc.)
const INTL_CALL_RE = /([A-Z]{1,2}\d[A-Z]{1,4}(?:\/[A-Z0-9]+)?)/g

// RST: 3-digit starting with 4 or 5
const TICKER_RST_RE = /([45]\d{2})/g
// US states + Canadian provinces
const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON',
  'PE', 'QC', 'SK', 'YT'
])
// State/province: match 2-letter codes anywhere
const STATE_RE = new RegExp('(' + [...STATE_CODES].join('|') + ')', 'g')

// Check if a match looks like a valid US or Canadian callsign prefix
function isUSorCACall (call) {
  const c0 = call[0]
  // US: K, N, W, or A(A-L)
  if (c0 === 'K' || c0 === 'N' || c0 === 'W') return true
  if (c0 === 'A' && call.length >= 2 && call[1] >= 'A' && call[1] <= 'L') return true
  // Canada: VA, VE, VO, VX, VY (VJ is reserved but rarely used)
  if (c0 === 'V' && call.length >= 2 && 'AEOYXJ'.includes(call[1])) return true
  return false
}

function parseTickerSegments (text, operatorCall) {
  if (!text) return []
  const upper = text.toUpperCase()
  const opCall = (operatorCall || '').toUpperCase()

  // Find all matches with positions
  // Priority: US callsign > international callsign > RST > state
  const matches = []

  function overlapsExisting (start, end) {
    return matches.some(x =>
      (start >= x.start && start < x.end) || (end > x.start && end <= x.end) ||
      (start <= x.start && end >= x.end)
    )
  }

  // 1a. US + Canadian callsigns first (highest priority)
  let m
  US_CA_CALL_RE.lastIndex = 0
  while ((m = US_CA_CALL_RE.exec(upper)) !== null) {
    if (m[1] !== opCall && isUSorCACall(m[1])) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[1], type: 'callsign' })
    }
  }

  // 1b. International callsigns — only where US/CA didn't already match
  INTL_CALL_RE.lastIndex = 0
  while ((m = INTL_CALL_RE.exec(upper)) !== null) {
    if (m[1] !== opCall && !overlapsExisting(m.index, m.index + m[0].length)) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[1], type: 'callsign' })
    }
  }

  // 2. RST reports
  TICKER_RST_RE.lastIndex = 0
  while ((m = TICKER_RST_RE.exec(upper)) !== null) {
    if (!overlapsExisting(m.index, m.index + m[0].length)) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[1], type: 'rst' })
    }
  }

  // 3. State/province codes
  STATE_RE.lastIndex = 0
  while ((m = STATE_RE.exec(upper)) !== null) {
    if (!overlapsExisting(m.index, m.index + m[0].length)) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[1], type: 'state' })
    }
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start)

  // Build segments (interleave plain text and tappable matches)
  const segments = []
  let pos = 0
  for (const match of matches) {
    if (match.start > pos) {
      segments.push({ text: text.slice(pos, match.start), type: 'plain' })
    }
    segments.push({ text: text.slice(match.start, match.end), type: match.type, value: match.value })
    pos = match.end
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), type: 'plain' })
  }

  return segments
}

// --- Control (InputComponent) ---
// Mounts when user taps Voice chip. Auto-starts voice session.
// Bridges VoiceSession to PoLo's updateQSO/onSubmitEditing/handleFieldChange.
export function VoiceLoggingControl (props) {
  const { style, styles, settings, qso, operation, vfo, updateQSO, onSubmitEditing, handleFieldChange } = props
  const [sessionState, setSessionState] = useState(VoiceSession.getState())

  const apiKey = settings?.accounts?.voiceLogging?.apiKey
  const dispatch = useDispatch()
  const qsosSelector = useCallback((state) => selectQSOs(state, operation?.uuid), [operation?.uuid])
  const qsos = useSelector(qsosSelector)

  // Correct an already-submitted log entry by callsign
  const correctLogEntry = useCallback((searchCall, corrections) => {
    if (!qsos || !operation?.uuid) return false

    const match = qsos.find(q => !q.deleted && q.their?.call?.toUpperCase() === searchCall.toUpperCase())
    if (!match) {
      console.log('VoiceLogging: correctLogEntry — no match for', searchCall)
      return false
    }

    const updated = { ...match }
    if (corrections.theirCall) {
      updated.their = { ...updated.their, call: corrections.theirCall }
    }
    if (corrections.ourSent) {
      updated.our = { ...updated.our, sent: corrections.ourSent }
    }
    if (corrections.theirSent) {
      updated.their = { ...updated.their, sent: corrections.theirSent }
    }
    if (corrections.state) {
      updated.their = { ...updated.their, state: corrections.state }
    }

    console.log('VoiceLogging: correctLogEntry — updating', searchCall, '→', JSON.stringify(corrections))
    dispatch(addQSO({ uuid: operation.uuid, qso: updated }))
    return true
  }, [qsos, operation?.uuid, dispatch])

  // Change VFO (frequency/band/mode) via voice command
  const changeVFO = useCallback((update) => {
    console.log('VoiceLogging: changeVFO', JSON.stringify(update))
    dispatch(setVFO(update))
  }, [dispatch])

  // Subscribe to VoiceSession state
  useEffect(() => {
    return VoiceSession.subscribe(setSessionState)
  }, [])

  // Bridge callbacks to VoiceSession
  useEffect(() => {
    console.log('VoiceLogging: Setting callbacks', !!updateQSO, !!onSubmitEditing, !!handleFieldChange, !!correctLogEntry, !!changeVFO)
    VoiceSession.setCallbacks({ updateQSO, onSubmitEditing, handleFieldChange, correctLogEntry, changeVFO })
    return () => VoiceSession.clearCallbacks()
  }, [updateQSO, onSubmitEditing, handleFieldChange, correctLogEntry, changeVFO])

  // Update session context when operation/VFO changes
  useEffect(() => {
    VoiceSession.setSessionContext({
      operatorCall: operation?.stationCall || '',
      band: vfo?.band || operation?.local?.band || '',
      mode: vfo?.mode || operation?.local?.mode || ''
    })
  }, [operation, vfo])

  // Auto-start voice session on mount (after context is set above)
  useEffect(() => {
    // Set context immediately so startSession picks up the correct mode
    VoiceSession.setSessionContext({
      operatorCall: operation?.stationCall || '',
      band: vfo?.band || operation?.local?.band || '',
      mode: vfo?.mode || operation?.local?.mode || ''
    })
    if (apiKey && sessionState.state === 'idle') {
      console.log('VoiceLogging: Auto-starting session, mode:', vfo?.mode || operation?.local?.mode || '(none)')
      VoiceSession.startSession(apiKey)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  const operatorCall = operation?.stationCall || ''

  const handleTickerTap = useCallback((type, value) => {
    if (type === 'callsign') {
      VoiceSession.populateField('theirCall', value)
    } else if (type === 'rst') {
      // First RST tap → ourSent (what we sent them), second → theirSent
      const last = VoiceSession.getLastWrittenValues()
      if (!last.ourSent) {
        VoiceSession.populateField('ourSent', value)
      } else if (!last.theirSent || last.theirSent === last.ourSent) {
        VoiceSession.populateField('theirSent', value)
      } else {
        // Both filled — overwrite ourSent
        VoiceSession.populateField('ourSent', value)
      }
    } else if (type === 'state') {
      VoiceSession.populateField('state', value)
    }
  }, [])

  const tickerSegments = sessionState.lastTranscript
    ? parseTickerSegments(sessionState.lastTranscript, operatorCall)
    : []

  return (
    <View style={[style, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
      {isActive && <KeepAwake />}
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 11 }} numberOfLines={1}>
          {sessionState.lastStatus || statusLabel}
        </Text>
        {tickerSegments.length > 0 ? (
          <Text style={{ color: '#fff', fontSize: 10, marginTop: 2, opacity: 0.8 }} numberOfLines={2}>
            {tickerSegments.map((seg, i) =>
              seg.type === 'plain' ? (
                <Text key={i}>{seg.text}</Text>
              ) : (
                <Text
                  key={i}
                  style={{ color: '#4FC3F7', textDecorationLine: 'underline' }}
                  onPress={() => handleTickerTap(seg.type, seg.value)}
                >
                  {seg.text}
                </Text>
              )
            )}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
