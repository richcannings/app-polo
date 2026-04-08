package com.ham2k.polo

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost

import cl.json.ShareApplication
import com.ham2k.polo.ggmorse.GGMorsePackage

class MainApplication : Application(), ReactApplication, ShareApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(GGMorsePackage())
        }
    )
  }

  override fun getFileProviderAuthority(): String = "$packageName.provider"

  override fun onCreate() {
    super.onCreate()

    loadReactNative(this)
  }
}
