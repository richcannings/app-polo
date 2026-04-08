/*
 * Copyright ©️ 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { VoiceLoggingAccountSetting } from './VoiceLoggingAccount'
import { VoiceLoggingChip } from './VoiceLoggingChip'
import { VoiceLoggingControl } from './VoiceLoggingControl'

export const Info = {
  key: 'voice-logging',
  icon: 'microphone',
  name: 'Voice Logging',
  description: 'Hands-free QSO logging via voice transcription',
  shortName: 'Voice'
}

const Extension = {
  ...Info,
  category: 'other',
  enabledByDefault: false,
  onActivation: ({ registerHook }) => {
    registerHook('setting', {
      hook: {
        key: 'voice-logging-account',
        category: 'account',
        SettingItem: VoiceLoggingAccountSetting
      }
    })
    registerHook('activity', { hook: ActivityHook })
  }
}
export default Extension

const ActivityHook = {
  ...Info,

  loggingControls: ({ operation, settings }) => {
    if (!settings?.['extensions/voice-logging']) return []
    if (!settings?.accounts?.voiceLogging?.apiKey) return []

    return [{
      key: 'voice-logging',
      order: 50,
      icon: Info.icon,
      label: 'Voice',
      LabelComponent: VoiceLoggingChip,
      InputComponent: VoiceLoggingControl,
      inputWidthMultiplier: 30,
      optionType: 'optional'
    }]
  }
}
