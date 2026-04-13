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
    // samplesPerFrame is at the BASE rate (4kHz), not the input rate
    // ggmorse resamples internally from sampleRateInp to kBaseSampleRate
    params.samplesPerFrame = GGMorse::kDefaultSamplesPerFrame; // 128
    params.sampleFormatInp = GGMORSE_SAMPLE_FORMAT_I16;
    params.sampleFormatOut = GGMORSE_SAMPLE_FORMAT_I16;
    LOGI("Using samplesPerFrame=%d (default, ignoring passed value %d)", params.samplesPerFrame, samplesPerFrame);

    try {
        g_ggmorse = new GGMorse(params);

        // Configure decode parameters: auto-detect pitch and speed
        GGMorse::ParametersDecode decodeParams = GGMorse::getDefaultParametersDecode();
        decodeParams.frequency_hz = -1.0f;       // auto-detect
        decodeParams.speed_wpm = -1.0f;           // auto-detect
        decodeParams.frequencyRangeMin_hz = 400.0f;
        decodeParams.frequencyRangeMax_hz = 900.0f;
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

    // Software gain — phone mic input is typically very quiet (~1% of full scale)
    // Amplify before feeding to ggmorse for better signal-to-noise
    static constexpr int GAIN = 10;

    // Write to ring buffer with gain, clamp to int16 range
    int16_t maxAmp = 0;
    for (int i = 0; i < length; i++) {
        int32_t amplified = (int32_t)samples[i] * GAIN;
        if (amplified > 32767) amplified = 32767;
        if (amplified < -32768) amplified = -32768;
        g_audioBuffer[g_audioWritePos % RING_BUFFER_SIZE] = (int16_t)amplified;
        g_audioWritePos++;
        int16_t absVal = amplified < 0 ? -amplified : amplified;
        if (absVal > maxAmp) maxAmp = absVal;
    }

    static int feedCount = 0;
    feedCount++;
    if (feedCount <= 3 || feedCount % 500 == 0) {
        LOGI("feedAudio #%d: %d samples, maxAmp=%d", feedCount, length, (int)maxAmp);
    }

    env->ReleaseShortArrayElements(audioData, samples, JNI_ABORT);
}

static int g_decodeCallCount = 0;

JNIEXPORT jstring JNICALL
Java_com_ham2k_polo_ggmorse_GGMorseModule_nativeDecode(
    JNIEnv *env, jobject thiz)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_ggmorse) {
        return env->NewStringUTF("");
    }

    g_decodeCallCount++;

    size_t availableBefore = g_audioWritePos - g_audioReadPos;

    // Log periodically
    if (g_decodeCallCount <= 3 || g_decodeCallCount % 500 == 0) {
        LOGI("decode #%d: available=%zu samples, writePos=%zu, readPos=%zu",
             g_decodeCallCount, availableBefore, g_audioWritePos, g_audioReadPos);
    }

    // CRITICAL: The callback MUST return exactly nMaxBytes or 0.
    // Returning partial data causes ggmorse to log "Failure during capture"
    // and corrupts the analysis window, producing garbled single-char output.
    GGMorse::CBWaveformInp cb = [](void *data, uint32_t nMaxBytes) -> uint32_t {
        uint32_t nMaxSamples = nMaxBytes / sizeof(int16_t);
        size_t avail = g_audioWritePos - g_audioReadPos;

        // All-or-nothing: if we don't have enough, return 0
        if (avail < nMaxSamples) {
            return 0;
        }

        int16_t *dst = (int16_t *)data;
        for (uint32_t i = 0; i < nMaxSamples; i++) {
            dst[i] = g_audioBuffer[(g_audioReadPos + i) % RING_BUFFER_SIZE];
        }
        g_audioReadPos += nMaxSamples;
        return nMaxBytes;
    };

    // Process multiple frames to drain buffered audio.
    // Each feedAudio delivers ~2048 samples but decode() consumes ~512 per frame,
    // so we loop to keep up. The callback returns 0 when the buffer runs low.
    std::string allDecoded;
    int maxIterations = 32;

    for (int iter = 0; iter < maxIterations; iter++) {
        // Pre-check: skip decode call if obviously not enough data
        size_t avail = g_audioWritePos - g_audioReadPos;
        if (avail < 128) break; // less than base frame size, no point calling decode

        g_ggmorse->decode(cb);

        GGMorse::TxRx rxData;
        int nDecoded = g_ggmorse->takeRxData(rxData);
        if (nDecoded > 0) {
            allDecoded.append(rxData.begin(), rxData.end());
        }

        // If callback returned 0 (not enough data), stop looping
        if (g_audioWritePos - g_audioReadPos == avail) break;
    }

    // Log stats periodically
    if (g_decodeCallCount % 500 == 0) {
        const GGMorse::Statistics &stats = g_ggmorse->getStatistics();
        LOGI("stats: pitch=%.1f Hz, wpm=%.1f, threshold=%.4f, cost=%.4f",
             stats.estimatedPitch_Hz, stats.estimatedSpeed_wpm,
             stats.signalThreshold, stats.costFunction);
    }

    if (!allDecoded.empty()) {
        LOGI("Decoded: '%s'", allDecoded.c_str());
        return env->NewStringUTF(allDecoded.c_str());
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
