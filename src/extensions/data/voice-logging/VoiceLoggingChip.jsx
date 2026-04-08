/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useCallback, useEffect, useState } from 'react'
import LoggerChip from '../../../screens/OperationScreens/components/LoggerChip'
import * as VoiceSession from './VoiceSession'

export function VoiceLoggingChip (props) {
  const { selected, onChange, settings, ...rest } = props
  const [sessionState, setSessionState] = useState(VoiceSession.getState())

  useEffect(() => {
    return VoiceSession.subscribe(setSessionState)
  }, [])

  const isActive = sessionState.state === 'listening' || sessionState.state === 'processing'

  // Auto-reselect if the control gets deselected while session is active
  // (happens when PoLo resets the form after submit)
  useEffect(() => {
    if (!selected && isActive) {
      onChange && onChange(true)
    }
  }, [selected, isActive, onChange])

  const handleChange = useCallback(() => {
    if (!selected) {
      // Select the control — InputComponent mounts and auto-starts session
      onChange && onChange(true)
    } else if (isActive) {
      // Pause recording but keep panel open
      VoiceSession.pauseSession()
    } else if (sessionState.state === 'paused') {
      // Resume recording
      VoiceSession.resumeSession()
    } else {
      // Idle or error — deselect and stop
      VoiceSession.stopSession()
      onChange && onChange(false)
    }
  }, [selected, isActive, sessionState.state, onChange])

  const iconName = isActive ? 'microphone' : 'microphone-off'
  const iconColor = isActive ? '#4CAF50'
    : sessionState.state === 'paused' ? '#FF9800'
    : sessionState.state === 'error' ? '#F44336'
    : undefined

  return (
    <LoggerChip
      {...rest}
      styles={rest.styles}
      selected={selected}
      icon={iconName}
      iconColor={iconColor}
      onChange={handleChange}
    >
      Voice
    </LoggerChip>
  )
}
