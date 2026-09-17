import java.io.ByteArrayOutputStream

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
    }

    buildTypes {
        release {
            // Unsigned release build — install directly, "Install unknown apps".
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

    androidResources {
        // The runtime is shipped as one .tar.xz; re-compressing it wastes time
        // and buys nothing. js/json stay uncompressed so the recursive asset
        // copy is a straight read.
        noCompress += listOf("xz", "js", "json")
    }
}

dependencies {
    // No nodejs-mobile dependency. Its release ships only libnode.so with no
    // Java layer and no exported entry point (verified with readelf), so this
    // app runs a real `node` executable instead — Termux's Android build,
    // fetched by :fetchTermuxNodejs below and spawned with ProcessBuilder.
    //
    // That also means no NDK and no abiFilters are needed: the binary lives in
    // assets/, not jniLibs/.
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")

    // Unpacks assets/runtime/usr.tar.xz. There is no xz in the Android platform
    // API, and this is pure JVM so it needs no native library of its own.
    implementation("org.apache.commons:commons-compress:1.26.2")
    implementation("org.tukaani:xz:1.9")
}

/**
 * Downloads Termux's nodejs-lts and its full dependency closure, prunes
 * build-time files, statically verifies the ELF dependency closure, and packs
 * the result as a single asset.
 *
 * ~22 MB packed. Deliberately not committed — see .gitignore.
 */
val fetchTermuxNodejs by tasks.registering(Exec::class) {
    val script = file("$rootDir/scripts/fetch-termux-nodejs.py")
    val workDir = layout.buildDirectory.dir("termux-nodejs/usr").get().asFile
    val tarball = file("$projectDir/src/main/assets/runtime/usr.tar.xz")

    inputs.file(script)
    outputs.file(tarball)

    doFirst {
        workDir.parentFile.mkdirs()
        tarball.parentFile.mkdirs()
    }
    commandLine(
        "python3", script.absolutePath,
        "--arch", "arm64-v8a",
        "--out", workDir.absolutePath,
        "--tarball", tarball.absolutePath,
    )

    doLast {
        if (!tarball.isFile) {
            throw GradleException("fetch-termux-nodejs.py produced no tarball")
        }
        val mb = tarball.length() / 1_000_000.0
        println("[termux-nodejs] asset ready: ${"%.1f".format(mb)} MB at ${tarball.relativeTo(rootDir)}")
    }
}

tasks.named("preBuild") {
    dependsOn(fetchTermuxNodejs)
}
