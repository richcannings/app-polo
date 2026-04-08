/*
 * Copyright 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

package com.ham2k.polo.ggmorse;

import android.util.Base64;
import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class GGMorseModule extends ReactContextBaseJavaModule {
    private static final String TAG = "GGMorseModule";
    private boolean initialized = false;

    static {
        System.loadLibrary("ggmorse-jni");
    }

    // Native methods
    private native boolean nativeInit(float sampleRate, int samplesPerFrame);
    private native void nativeDestroy();
    private native void nativeFeedAudio(short[] audioData, int length);
    private native String nativeDecode();
    private native float[] nativeGetStats();

    public GGMorseModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "GGMorseModule";
    }

    @ReactMethod
    public void startDecoder(double sampleRate, Promise promise) {
        try {
            // samplesPerFrame: at 16kHz input, internal rate is 4kHz, default frame is 128
            // so input frame = (16000/4000) * 128 = 512 samples
            int samplesPerFrame = (int)((sampleRate / 4000.0) * 128);
            initialized = nativeInit((float) sampleRate, samplesPerFrame);
            if (initialized) {
                Log.i(TAG, "Decoder started: sampleRate=" + sampleRate + " samplesPerFrame=" + samplesPerFrame);
                promise.resolve(true);
            } else {
                promise.reject("INIT_FAILED", "Failed to initialize ggmorse");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting decoder", e);
            promise.reject("INIT_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void feedAudio(String base64Data, Promise promise) {
        if (!initialized) {
            promise.resolve("");
            return;
        }

        try {
            // Decode base64 PCM data to raw bytes
            byte[] rawBytes = Base64.decode(base64Data, Base64.DEFAULT);

            // Convert bytes to int16 samples
            ByteBuffer bb = ByteBuffer.wrap(rawBytes).order(ByteOrder.LITTLE_ENDIAN);
            short[] samples = new short[rawBytes.length / 2];
            for (int i = 0; i < samples.length; i++) {
                samples[i] = bb.getShort();
            }

            // Feed to ggmorse and decode
            nativeFeedAudio(samples, samples.length);
            String decoded = nativeDecode();

            // Emit decoded text if non-empty
            if (decoded != null && !decoded.isEmpty()) {
                sendEvent("onMorseText", decoded);
            }

            // Return stats
            float[] stats = nativeGetStats();
            if (stats != null && stats.length >= 4) {
                WritableMap statsMap = Arguments.createMap();
                statsMap.putDouble("pitch", stats[0]);
                statsMap.putDouble("wpm", stats[1]);
                statsMap.putDouble("threshold", stats[2]);
                statsMap.putDouble("cost", stats[3]);

                if (stats[0] > 0 || stats[1] > 0) {
                    sendStatsEvent(statsMap);
                }
            }

            promise.resolve(decoded);
        } catch (Exception e) {
            Log.e(TAG, "Error feeding audio", e);
            promise.resolve("");
        }
    }

    @ReactMethod
    public void stopDecoder(Promise promise) {
        if (initialized) {
            nativeDestroy();
            initialized = false;
            Log.i(TAG, "Decoder stopped");
        }
        promise.resolve(true);
    }

    private void sendEvent(String eventName, String data) {
        ReactApplicationContext context = getReactApplicationContext();
        if (context.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putString("text", data);
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(eventName, params);
        }
    }

    private void sendStatsEvent(WritableMap stats) {
        ReactApplicationContext context = getReactApplicationContext();
        if (context.hasActiveReactInstance()) {
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onMorseStats", stats);
        }
    }

    @ReactMethod
    public void addListener(String eventName) {
        // Required for RN NativeEventEmitter
    }

    @ReactMethod
    public void removeListeners(int count) {
        // Required for RN NativeEventEmitter
    }
}
