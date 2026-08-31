# Pressboxd app icon / splash source

Before generating store assets, put ONE square image here named:

    logo.png

Recommended: 1024x1024 PNG or larger.

For a quick test build you can copy the existing Pressboxd favicon:

Windows PowerShell (run from the `mobile` folder):

    Copy-Item ..\static\favicon.png .\assets\logo.png

macOS/Linux:

    cp ../static/favicon.png ./assets/logo.png

Then run:

    npm run assets

For App Store / Play Store release, replace `assets/logo.png` with a clean,
high-resolution 1024x1024 Pressboxd icon before running `npm run assets` again.
