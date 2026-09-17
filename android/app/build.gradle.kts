plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.soundwave.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.soundwave.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Only 64-bit. Dropping armeabi-v7a roughly halves the APK, and any phone
        // new enough to run this comfortably is arm64.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            // Unsigned release build — install with `adb install` or enable
            // "Install unknown apps". A signed build needs a keystore.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // The bundled Node project is plain data in assets/; keep Gradle from
    // trying to compress or merge it in ways that break the recursive copy.
    androidResources {
        noCompress += listOf("js", "json")
    }
}

dependencies {
    // UNVERIFIED COORDINATE.
    //
    // This is the one line I could not confirm: the Maven coordinate for the
    // community-maintained nodejs-mobile build. The upstream project
    // (JaneaSystems) is unmaintained; the live fork is github.com/nodejs-mobile
    // and publishes from there. If the build fails with "Could not find
    // com.janeasystems:nodejs-mobile", this line is why — check that repo's
    // README for the current coordinate and version and change only this line.
    //
    // Everything else in this project follows the documented integration
    // pattern: assets/nodejs-project is copied to filesDir, then NodeJsMobile
    // is started with a script path.
    implementation("com.janeasystems:nodejs-mobile:0.10.1")

    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
