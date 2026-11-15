#!/usr/bin/env bash
# Assistive Smart Mirror — Raspberry Pi 4 setup
# Run on the Pi (Raspberry Pi OS 64-bit Desktop, Bookworm or newer), from the repo root:
#   bash scripts/setup-pi.sh            # MagicMirror² + module + espeak-ng
#   bash scripts/setup-pi.sh --piper    # also install the Piper neural voice
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MM="$HOME/MagicMirror"
WANT_PIPER=0
[[ "${1:-}" == "--piper" ]] && WANT_PIPER=1

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "System packages"
sudo apt-get update
sudo apt-get install -y git curl espeak-ng alsa-utils wlr-randr

step "Node.js 22 (MagicMirror² needs a newer Node than Raspberry Pi OS ships)"
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ "${NODE_MAJOR:-0}" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

step "MagicMirror²"
if [[ ! -d "$MM" ]]; then
  git clone --depth 1 https://github.com/MagicMirrorOrg/MagicMirror "$MM"
fi
cd "$MM"
npm run install-mm

step "Assistive module, config and styles"
rm -rf "$MM/modules/MMM-AssistCare"
cp -r "$REPO/MagicMirror/modules/MMM-AssistCare" "$MM/modules/"
[[ -f "$MM/config/config.js" ]] && cp "$MM/config/config.js" "$MM/config/config.js.bak.$(date +%s)"
cp "$REPO/MagicMirror/config/config.js" "$MM/config/config.js"
cp "$REPO/MagicMirror/css/custom.css" "$MM/css/custom.css"
(cd "$MM/modules/MMM-AssistCare" && npm install --omit=dev)

step "Serial port permission"
sudo usermod -aG dialout "$USER"

step "Wayland display name"
WL=$(ls "/run/user/$(id -u)" 2>/dev/null | grep -E '^wayland-[0-9]+$' | head -1 || true)
WL=${WL:-wayland-0}
echo "Using WAYLAND_DISPLAY=$WL"
sed -i "s/WAYLAND_DISPLAY: \"wayland-[0-9]*\"/WAYLAND_DISPLAY: \"$WL\"/" "$MM/modules/MMM-AssistCare/MMM-AssistCare.js"
OUT=$(WAYLAND_DISPLAY=$WL XDG_RUNTIME_DIR=/run/user/$(id -u) wlr-randr 2>/dev/null | awk 'NR==1{print $1}' || true)
if [[ -n "$OUT" ]]; then
  echo "Display output: $OUT"
  sed -i "s/--output HDMI-A-[0-9]/--output $OUT/g" "$MM/modules/MMM-AssistCare/MMM-AssistCare.js"
fi

step "Disable desktop screen blanking (the module controls the screen)"
sudo raspi-config nonint do_blanking 1 || true

step "pm2 process manager + start on login"
sudo npm install -g pm2
pm2 delete mm >/dev/null 2>&1 || true
WAYLAND_DISPLAY=$WL pm2 start npm --name mm --cwd "$MM" -- run start:wayland
pm2 save
mkdir -p "$HOME/.config/labwc"
touch "$HOME/.config/labwc/autostart"
grep -q "pm2 resurrect" "$HOME/.config/labwc/autostart" || echo "pm2 resurrect &" >> "$HOME/.config/labwc/autostart"

if [[ $WANT_PIPER -eq 1 ]]; then
  step "Piper neural TTS (optional)"
  mkdir -p "$HOME/piper"
  cd "$HOME/piper"
  curl -fL -o piper.tar.gz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz
  tar -xzf piper.tar.gz --strip-components=1
  curl -fL -o en_GB-alba-medium.onnx      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx
  curl -fL -o en_GB-alba-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json
  echo "Hello, this is the mirror voice." | ./piper --model en_GB-alba-medium.onnx --output-raw | aplay -q -r 22050 -f S16_LE -t raw - \
    && echo "Piper works. Set tts.engine to \"piper\" in config.js (piperBin/piperModel default to ~/piper for user 'pi'; change if your user differs)."
fi

step "Speaker test"
espeak-ng -s 140 -v en-gb "The mirror is set up." || echo "No sound? Select the USB speaker as the audio output (top-right speaker icon)."

cat <<EOF

Done.
  - Log out and back in (or reboot) once so the serial permission applies.
  - Logs:     pm2 logs mm
  - Restart:  pm2 restart mm
  - Edit reminders: $MM/modules/MMM-AssistCare/data/schedule.json
  - Set the time zone if needed: sudo timedatectl set-timezone Asia/Dubai
EOF
