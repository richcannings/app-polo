/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useTranslation } from 'react-i18next'

import { setSettings } from '../../../store/settings'

import { H2kButton, H2kDialog, H2kDialogActions, H2kDialogContent, H2kDialogTitle, H2kListItem, H2kTextInput } from '../../../ui'

export function VoiceLoggingAccountSetting ({ settings, styles }) {
  const { t } = useTranslation()

  const [currentDialog, setCurrentDialog] = useState()
  return (
    <>
      <H2kListItem
        title="Voice Logging (OpenAI API)"
        description={settings?.accounts?.voiceLogging?.apiKey ? 'API Key configured' : 'No API key'}
        leftIcon={'microphone'}
        onPress={() => setCurrentDialog('voiceLogging')}
      />
      {currentDialog === 'voiceLogging' && (
        <VoiceLoggingDialog
          settings={settings}
          styles={styles}
          visible={true}
          onDialogDone={() => setCurrentDialog('')}
        />
      )}
    </>
  )
}

function VoiceLoggingDialog ({ settings, styles, visible, onDialogDone }) {
  const dispatch = useDispatch()

  const [apiKey, setApiKey] = useState(settings?.accounts?.voiceLogging?.apiKey ?? '')
  const [autoSubmit, setAutoSubmit] = useState(settings?.accounts?.voiceLogging?.autoSubmit ?? true)

  useEffect(() => {
    setApiKey(settings?.accounts?.voiceLogging?.apiKey ?? '')
    setAutoSubmit(settings?.accounts?.voiceLogging?.autoSubmit ?? true)
  }, [settings])

  const handleSave = useCallback(() => {
    dispatch(setSettings({
      accounts: {
        ...settings?.accounts,
        voiceLogging: { apiKey, autoSubmit }
      }
    }))
    onDialogDone()
  }, [dispatch, settings, apiKey, autoSubmit, onDialogDone])

  return (
    <H2kDialog visible={visible} onDismiss={onDialogDone}>
      <H2kDialogTitle>Voice Logging</H2kDialogTitle>
      <H2kDialogContent>
        <H2kTextInput
          label="OpenAI API Key"
          value={apiKey}
          secureTextEntry={true}
          onChangeText={setApiKey}
          style={{ marginBottom: styles.oneSpace * 2 }}
        />
      </H2kDialogContent>
      <H2kDialogActions>
        <H2kButton onPress={onDialogDone}>Cancel</H2kButton>
        <H2kButton onPress={handleSave} mode="contained">Save</H2kButton>
      </H2kDialogActions>
    </H2kDialog>
  )
}
