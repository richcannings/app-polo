/*
 * Copyright 2025 Rich Cannings <rcannings@gmail.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <mutex>
#include <vector>

#include "ggmorse.h"

#define LOG_TAG "GGMorseJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static GGMorse *g_ggmorse = nullptr;
static std::mutex g_mutex;

// Ring buffer for audio data
static std::vector<int16_t> g_audioBuffer;
static size_t g_audioReadPos = 0;
static size_t g_audioWritePos = 0;
static const size_t RING_BUFFER_SIZE = 16000 * 10; // 10 seconds at 16kHz

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeInit(
    JNIEnv *env, jobject thiz, jfloat sampleRate, jint samplesPerFrame)
{
    std::lock_guard<std::mutex> lock(g_mutex);

    if (g_ggmorse) {
        delete g_ggmorse;
        g_ggmorse = nullptr;
    }

    // Initialize ring buffer
    g_audioBuffer.resize(RING_BUFFER_SIZE, 0);
    g_audioReadPos = 0;
    g_audioWritePos = 0;

    GGMorse::Parameters params;
    params.sampleRateInp = sampleRate;
    params.sampleRateOut = sampleRate;
    params.samplesPerFrame = samplesPerFrame;
    params.sampleFormatInp = GGMORSE_SAMPLE_FORMAT_I16;
    params.sampleFormatOut = GGMORSE_SAMPLE_FORMAT_I16;

    try {
        g_ggmorse = new GGMorse(params);

        // Configure decode parameters: auto-detect pitch and speed
        GGMorse::ParametersDecode decodeParams = GGMorse::getDefaultParametersDecode();
        decodeParams.frequency_hz = -1.0f;       // auto-detect
        decodeParams.speed_wpm = -1.0f;           // auto-detect
        decodeParams.frequencyRangeMin_hz = 200.0f;
        decodeParams.frequencyRangeMax_hz = 1200.0f;
        decodeParams.applyFilterHighPass = true;
        decodeParams.applyFilterLowPass = true;
        g_ggmorse->setParametersDecode(decodeParams);

        LOGI("ggmorse initialized: sampleRate=%.0f, samplesPerFrame=%d", sampleRate, samplesPerFrame);
        return JNI_TRUE;
    } catch (...) {
        LOGE("Failed to initialize ggmorse");
        return JNI_FALSE;
    }
}

JNIEXPORT void JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeDestroy(
    JNIEnv *env, jobject thiz)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_ggmorse) {
        delete g_ggmorse;
        g_ggmorse = nullptr;
    }
    g_audioBuffer.clear();
    g_audioReadPos = 0;
    g_audioWritePos = 0;
    LOGI("ggmorse destroyed");
}

JNIEXPORT void JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeFeedAudio(
    JNIEnv *env, jobject thiz, jshortArray audioData, jint length)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_ggmorse || length <= 0) return;

    jshort *samples = env->GetShortArrayElements(audioData, nullptr);
    if (!samples) return;

    // Write to ring buffer
    for (int i = 0; i < length; i++) {
        g_audioBuffer[g_audioWritePos % RING_BUFFER_SIZE] = samples[i];
        g_audioWritePos++;
    }

    env->ReleaseShortArrayElements(audioData, samples, JNI_ABORT);
}

JNIEXPORT jstring JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeDecode(
    JNIEnv *env, jobject thiz)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_ggmorse) {
        return env->NewStringUTF("");
    }

    // Decode using pull callback — ggmorse requests audio from our ring buffer
    GGMorse::CBWaveformInp cb = [](void *data, uint32_t nMaxBytes) -> uint32_t {
        uint32_t nMaxSamples = nMaxBytes / sizeof(int16_t);
        size_t available = g_audioWritePos - g_audioReadPos;
        if (available == 0) return 0;

        uint32_t toRead = std::min((uint32_t)available, nMaxSamples);
        int16_t *dst = (int16_t *)data;
        for (uint32_t i = 0; i < toRead; i++) {
            dst[i] = g_audioBuffer[(g_audioReadPos + i) % RING_BUFFER_SIZE];
        }
        g_audioReadPos += toRead;
        return toRead * sizeof(int16_t);
    };

    g_ggmorse->decode(cb);

    // Get decoded text
    GGMorse::TxRx rxData;
    int nDecoded = g_ggmorse->takeRxData(rxData);

    if (nDecoded > 0) {
        std::string text(rxData.begin(), rxData.end());
        LOGI("Decoded: '%s'", text.c_str());
        return env->NewStringUTF(text.c_str());
    }

    return env->NewStringUTF("");
}

JNIEXPORT jfloatArray JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeGetStats(
    JNIEnv *env, jobject thiz)
{
    std::lock_guard<std::mutex> lock(g_mutex);

    jfloatArray result = env->NewFloatArray(4);
    if (!g_ggmorse) return result;

    const GGMorse::Statistics &stats = g_ggmorse->getStatistics();
    float values[4] = {
        stats.estimatedPitch_Hz,
        stats.estimatedSpeed_wpm,
        stats.signalThreshold,
        stats.costFunction
    };
    env->SetFloatArrayRegion(result, 0, 4, values);
    return result;
}

} // extern "C"
