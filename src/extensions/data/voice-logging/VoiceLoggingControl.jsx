/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useCallback, useState } from 'react'
import { View } from 'react-native'
import { IconButton } from 'react-native-paper'

import { H2kText } from '../../../ui'

export function VoiceLoggingControl (props) {
  const { style, styles, themeColor } = props

  const [isListening, setIsListening] = useState(false)

  const handleToggleListening = useCallback(() => {
    setIsListening(prev => !prev)
    // TODO: Start/stop VoiceSession
  }, [])

  return (
    <View style={[style, { flexDirection: 'row', alignItems: 'center', gap: styles.oneSpace }]}>
      <IconButton
        icon={isListening ? 'microphone' : 'microphone-off'}
        iconColor={isListening ? themeColor : 'gray'}
        size={styles.oneSpace * 3}
        onPress={handleToggleListening}
      />
      <H2kText style={{ color: isListening ? themeColor : 'gray' }}>
        {isListening ? 'Listening' : 'Paused'}
      </H2kText>
    </View>
  )
}
