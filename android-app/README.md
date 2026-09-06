# Employee Attendance Android App

This Android wrapper packages the current `reference-app` web app and requests location permission for employee check-in and movement monitoring. Check-out remains unrestricted by location, matching the web version.

## Build with Android Studio

1. Open the `android-app` folder in Android Studio.
2. Let Gradle sync and install Android SDK 35 if prompted.
3. Run on a device to test GPS permissions.
4. Use **Build > Generate Signed Bundle / APK > Android App Bundle**.
5. Create and securely store a release keystore, then upload the generated `.aab` to Google Play Console.

The current environment did not have Android SDK/Gradle installed, so an AAB could not be generated here. Before Play Store publication, add a privacy policy, app icon, screenshots, content rating, and a secure release keystore.