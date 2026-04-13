cmake_minimum_required(VERSION 3.13)

# Define the library name here.
project(appmodules)

# This file includes all the necessary to let you build your application with the New Architecture.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# --- ggmorse native library ---
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(ggmorse STATIC
    ggmorse/ggmorse.cpp
    ggmorse/resampler.cpp
)
target_include_directories(ggmorse PUBLIC ggmorse)

add_library(ggmorse-jni SHARED
    ggmorse/ggmorse_jni.cpp
)
target_link_libraries(ggmorse-jni
    ggmorse
    log
)
