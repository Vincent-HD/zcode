{
  lib,
  stdenvNoCC,
  fetchPnpmDeps,
  pnpm_11,
  pnpmConfigHook,
  nodejs_24,
  writableTmpDirAsHomeHook,
  src,
  version,
  pnpmDepsHash,
  upstreamSource,
  spdxLicenseList,
  spdxLicenseListVersion,
}:

let
  upstreamCompatibilityCheck = stdenvNoCC.mkDerivation {
    pname = "z-code-upstream-compatibility-check";
    inherit version;
    dontUnpack = true;

    nativeBuildInputs = [ nodejs_24 ];

    buildPhase = ''
      runHook preBuild

      node ${src}/nix/verify-upstream-dependencies.mjs ${src} ${upstreamSource} ${version} git-flake-snapshot

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      touch "$out"
      runHook postInstall
    '';
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "z-code-renderer-server";
  inherit version src;

  outputs = [
    "out"
    "server"
  ];
  pnpmWorkspaces = [ "t3..." ];
  pnpmInstallFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    writableTmpDirAsHomeHook
    # The renderer depends on this check even when Nix reuses the fixed-output pnpm closure.
    upstreamCompatibilityCheck
  ];

  pnpmDeps =
    (fetchPnpmDeps {
      pname = finalAttrs.pname;
      version = finalAttrs.version;
      src = finalAttrs.src;
      pnpm = pnpm_11;
      pnpmWorkspaces = finalAttrs.pnpmWorkspaces;
      fetcherVersion = 4;
      hash = pnpmDepsHash;
    }).overrideAttrs
      (oldAttrs: {
        # Run compatibility validation before pnpm's fixed-output closure is fetched.
        buildInputs = (oldAttrs.buildInputs or [ ]) ++ [ upstreamCompatibilityCheck ];
      });

  env.APP_VERSION = finalAttrs.version;
  env.T3CODE_WEB_SOURCEMAP = "false";

  buildPhase = ''
    runHook preBuild

    cp .env.example .env
    spdxLicenseCacheDirectory=".generated/third-party-licenses/spdx/${spdxLicenseListVersion}"
    mkdir -p "$spdxLicenseCacheDirectory"
    export SPDX_LICENSE_CACHE_DIRECTORY="$spdxLicenseCacheDirectory"
    node --input-type=module - ${spdxLicenseList} <<'NODE'
      import fs from "node:fs";
      import path from "node:path";

      const config = JSON.parse(fs.readFileSync("third-party-licenses.config.json", "utf8"));
      const entries = [...(config.customNotices ?? []), ...(config.packageOverrides ?? [])];
      const licenseIds = new Set();
      for (const entry of entries) {
        const generatedNotices = entry.generatedNotices ?? (entry.generatedNotice ? [entry.generatedNotice] : []);
        for (const notice of generatedNotices) {
          if (typeof notice.licenseId === "string") licenseIds.add(notice.licenseId);
        }
      }

      const spdxRoot = process.argv[2];
      for (const licenseId of licenseIds) {
        const source = path.join(spdxRoot, "json", "details", encodeURIComponent(licenseId) + ".json");
        const details = JSON.parse(fs.readFileSync(source, "utf8"));
        if (details.licenseId !== licenseId || typeof details.licenseText !== "string") {
          throw new Error("Pinned SPDX data is missing valid details for " + licenseId + ".");
        }
        const target = path.join(process.env.SPDX_LICENSE_CACHE_DIRECTORY, licenseId + ".json");
        fs.writeFileSync(target, JSON.stringify({ licenseId, licenseText: details.licenseText.trim() }) + "\n");
      }
    NODE

    node --input-type=module -e '
      import fs from "node:fs";
      const file = "apps/server/package.json";
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.version = process.env.APP_VERSION;
      fs.writeFileSync(file, JSON.stringify(pkg));
    '
    pnpm --config.verify-deps-before-run=false --filter @t3tools/web build
    pnpm --config.verify-deps-before-run=false --filter t3 build:bundle

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out" "$server"
    cp -R apps/web/dist/. "$out/"
    cp -R apps/server/dist/. "$server/"
    test -f "$out/index.html"
    test -f "$server/bin.mjs"
    test -f "$server/claude-history-worker.mjs"

    runHook postInstall
  '';

  passthru = {
    inherit pnpmDepsHash;
    source = src;
    inherit upstreamCompatibilityCheck;
  };

  meta = {
    description = "T3 Code web renderer and server built from this checkout";
    homepage = "https://github.com/pingdotgg/t3code";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
  };
})
