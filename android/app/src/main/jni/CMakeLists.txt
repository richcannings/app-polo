cmake_minimum_required(VERSION 3.10)
project(ggmorse-jni)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ggmorse library
add_library(ggmorse STATIC
    ggmorse/ggmorse.cpp
    ggmorse/resampler.cpp
)
target_include_directories(ggmorse PUBLIC ggmorse)

# JNI bridge
add_library(ggmorse-jni SHARED
    ggmorse_jni.cpp
)
target_link_libraries(ggmorse-jni
    ggmorse
    log
)
