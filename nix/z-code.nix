{
  lib,
  appimageTools,
  asar,
  fetchurl,
  runCommand,
  symlinkJoin,
  rendererServer,
  version,
  appImageHash,
  upstreamSourceHash,
}:

let
  appImage = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage";
    hash = appImageHash;
  };

  upstreamExtracted = appimageTools.extract {
    pname = "t3code";
    inherit version;
    src = appImage;
  };

  extracted =
    runCommand "z-code-${version}-repacked"
      {
        nativeBuildInputs = [ asar ];
      }
      ''
        cp -R ${upstreamExtracted} "$out"
        chmod -R u+w "$out"
        asar extract "$out/resources/app.asar" app
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

        rm "$out/resources/app.asar"
        rm -rf "$out/resources/app.asar.unpacked"
        asar pack app "$out/resources/app.asar" --unpack-dir 'node_modules'
        asar list "$out/resources/app.asar" > asar-files
        grep -Fx '/apps/server/dist/bin.mjs' asar-files
        grep -Fx '/apps/server/dist/client/index.html' asar-files
      '';

  wrapped = appimageTools.wrapAppImage {
    pname = "z-code";
    inherit version;
    src = appImage;
    contents = extracted;
    extraPkgs = pkgs: [ pkgs.libsecret ];
    meta = {
      description = "T3 Code desktop application built from this checkout";
      homepage = "https://t3.codes";
      changelog = "https://github.com/pingdotgg/t3code/releases/tag/v${version}";
      license = lib.licenses.mit;
      mainProgram = "z-code";
      platforms = [ "x86_64-linux" ];
    };
  };
in
symlinkJoin {
  name = "z-code-${version}";
  paths = [ wrapped ];
  postBuild = ''
    ln -s "$out/bin/z-code" "$out/bin/t3code"
    ln -s "$out/bin/z-code" "$out/bin/zcode"
  '';

  passthru = {
    inherit extracted;
    upstreamVersion = version;
    upstreamTag = "v${version}";
    upstreamAppImageHash = appImageHash;
    inherit upstreamSourceHash;
    inherit rendererServer;
  };

  meta = {
    description = "T3 Code desktop application with this checkout's renderer and server";
    homepage = "https://t3.codes";
    changelog = "https://github.com/pingdotgg/t3code/releases/tag/v${version}";
    license = lib.licenses.mit;
    mainProgram = "z-code";
    platforms = [ "x86_64-linux" ];
  };
}
