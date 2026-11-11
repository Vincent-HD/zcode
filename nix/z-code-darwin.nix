{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  asar,
  nodejs_24,
  python3,
  darwin,
  rendererServer,
  version,
  macZipHash,
  upstreamSourceHash,
}:

let
  appName = "T3 Code (Nightly)";

  macZip = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-arm64.zip";
    hash = macZipHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = "z-code";
  inherit version;
  src = macZip;
  sourceRoot = ".";

  nativeBuildInputs = [
    unzip
    asar
    nodejs_24
    python3
  ];

  dontBuild = true;
  # Generic fixup rewrites scripts inside Electron resources; signing happens explicitly below.
  dontFixup = true;

  installPhase = ''
    runHook preInstall

    app="$out/Applications/${appName}.app"
    resources="$app/Contents/Resources"
    mkdir -p "$out/Applications" "$out/bin"
    cp -R "${appName}.app" "$app"
    chmod -R u+w "$app"

    asar extract "$resources/app.asar" app
    test -f app/apps/server/dist/client/index.html
    test -f app/apps/server/dist/client/third-party-licenses.json

    rm -r app/apps/server/dist
    mkdir -p app/apps/server/dist
    cp -R ${rendererServer.server}/. app/apps/server/dist/
    rm -rf app/apps/server/dist/client
    mkdir -p app/apps/server/dist/client
    cp -R ${rendererServer}/. app/apps/server/dist/client/
    chmod -R u+w app
    test -f app/apps/server/dist/client/third-party-licenses.json

    rm "$resources/app.asar"
    rm -rf "$resources/app.asar.unpacked"
    asar pack app "$resources/app.asar" --unpack-dir 'node_modules'
    asar list "$resources/app.asar" > asar-files
    grep -Fx '/apps/server/dist/bin.mjs' asar-files
    grep -Fx '/apps/server/dist/client/index.html' asar-files

    # Electron's asar integrity fuse refuses to start unless Info.plist carries
    # the SHA-256 of the repacked archive header.
    asarHeaderHash="$(node -e '
      const asar = require(process.argv[1]);
      const header = asar.getRawHeader(process.argv[2]).headerString;
      process.stdout.write(require("node:crypto").createHash("sha256").update(header).digest("hex"));
    ' ${asar}/lib/node_modules/@electron/asar "$resources/app.asar")"
    python3 - "$app/Contents/Info.plist" "$asarHeaderHash" <<'PY'
    import plistlib
    import sys

    path, header_hash = sys.argv[1], sys.argv[2]
    with open(path, "rb") as handle:
        info = plistlib.load(handle)
    integrity = info.get("ElectronAsarIntegrity", {})
    if "Resources/app.asar" not in integrity:
        raise SystemExit("Info.plist has no ElectronAsarIntegrity entry for Resources/app.asar")
    integrity["Resources/app.asar"] = {"algorithm": "SHA256", "hash": header_hash}
    with open(path, "wb") as handle:
        plistlib.dump(info, handle)
    PY

    # Changing app.asar and Info.plist breaks the Developer ID seal. Re-sign every
    # Mach-O ad hoc so Apple Silicon still runs the bundle; the stale seal goes away.
    find "$app" -type d -name _CodeSignature -prune -exec rm -rf {} +
    rm -f "$app/Contents/embedded.provisionprofile"
    source ${darwin.signingUtils}
    while IFS= read -r -d $'\0' file; do
      signIfRequired "$file"
    done < <(find "$app" -type f -print0)

    executable="$app/Contents/MacOS/${appName}"
    ln -s "$executable" "$out/bin/z-code"
    ln -s "$executable" "$out/bin/zcode"
    ln -s "$executable" "$out/bin/t3code"

    runHook postInstall
  '';

  passthru = {
    inherit rendererServer upstreamSourceHash;
    upstreamVersion = version;
    upstreamTag = "v${version}";
    upstreamMacZipHash = macZipHash;
  };

  meta = {
    description = "T3 Code desktop application with this checkout's renderer and server";
    homepage = "https://t3.codes";
    changelog = "https://github.com/pingdotgg/t3code/releases/tag/v${version}";
    license = lib.licenses.mit;
    mainProgram = "z-code";
    platforms = [ "aarch64-darwin" ];
  };
}
