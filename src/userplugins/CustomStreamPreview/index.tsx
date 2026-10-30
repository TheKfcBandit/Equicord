/*
 * Vencord / Equicord Plugin: CustomStreamPreview
 *
 * Original feature by yofukashino (DiscordBypasses / Replugged)
 * Converted to standalone Vencord/Equicord TypeScript plugin.
 *
 * Behaviour:
 *   - Toggle OFF  → Discord captures stream thumbnail normally (no-op).
 *   - Toggle ON, no image → original thumbnail is used (fail-safe).
 *   - Toggle ON, image set → your custom JPEG is sent as the thumbnail.
 *
 * Install:
 *   Copy this FOLDER to  <Equicord>/src/userplugins/CustomStreamPreview/
 *   then run  pnpm build  from the Equicord repo root.
 *   Enable the plugin in Discord → Settings → Equicord/Vencord → Plugins.
 */

// Relative imports — works in any Vencord/Equicord build regardless of
// whether the build system exposes the @api / @utils / @webpack aliases.
import { del, get, set } from "../../api/DataStore";
import { definePluginSettings } from "../../api/Settings";
import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import { Logger } from "../../utils/Logger";
import definePlugin, { OptionType } from "../../utils/types";
import { React, showToast } from "../../webpack/common";

// IndexedDB storage is persistent across settings page remounts.
// Do not claim success until the write transaction completes.
const STORAGE_KEY = "CustomStreamPreview_fakePreview";
const logger = new Logger("CustomStreamPreview");
let cachedPreview = "";
let revision = 0;
let loadPromise: Promise<string> | undefined;

function loadPreview(): Promise<string> {
    return loadPromise ??= get<string>(STORAGE_KEY).then(async saved => {
        let value = saved ?? "";
        // One-time migration from the previous localStorage implementation.
        if (!value) {
            try {
                const legacy = localStorage.getItem(STORAGE_KEY);
                if (legacy) {
                    await set(STORAGE_KEY, legacy);
                    value = legacy;
                    localStorage.removeItem(STORAGE_KEY);
                }
            } catch (error) {
                logger.warn("Legacy preview migration unavailable", error);
            }
        }
        return value;
    }).catch(error => {
        loadPromise = undefined;
        logger.error("Failed to load custom stream preview", error);
        throw error;
    });
}

async function persistPreview(value: string): Promise<void> {
    if (value) await set(STORAGE_KEY, value);
    else await del(STORAGE_KEY);
    cachedPreview = value;
    loadPromise = Promise.resolve(value);
    revision++;
}

async function hydratePreview(): Promise<string> {
    const before = revision;
    const value = await loadPreview();
    if (before === revision) cachedPreview = value;
    return cachedPreview;
}

// ─── settings ─────────────────────────────────────────────────────────────────
const settings = definePluginSettings({
    streamPreview: {
        type: OptionType.BOOLEAN,
        description:
            "Intercept stream preview capture. " +
            "Enabled + no image → normal thumbnail (no replacement). " +
            "Enabled + image set → custom image sent as thumbnail.",
        default: false,
    },
    previewPicker: {
        type: OptionType.COMPONENT,
        description: "Custom preview image  (any format → auto-converted to JPEG, max 200 KB)",
        component: () => <ImagePickerComponent />,
    },
});

// ─── image picker component ───────────────────────────────────────────────────
function ImagePickerComponent() {
    const { streamPreview } = settings.use(["streamPreview"]);
    const [image, setImageState] = React.useState<string>(cachedPreview);

    React.useEffect(() => {
        let active = true;
        void hydratePreview().then(value => {
            if (active) setImageState(value);
        }).catch(() => {
            if (active) showToast({ text: "Could not load saved stream preview.", variant: "critical" });
        });
        return () => { active = false; };
    }, []);

    async function updateImage(value: string): Promise<boolean> {
        try {
            await persistPreview(value);
            setImageState(value);
            return true;
        } catch (error) {
            logger.error("Failed to save stream preview", error);
            showToast({ text: "Could not save custom stream preview.", variant: "critical" });
            return false;
        }
    }

    function openFilePicker() {
        const input = document.createElement("input");
        input.type   = "file";
        input.accept = "image/*";

        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = ev => {
                const rawDataUrl = ev.target?.result as string;

                // Re-encode as JPEG to match canvas.toDataURL("image/jpeg").
                const img = new Image();
                img.onload = async () => {
                    const canvas = document.createElement("canvas");
                    canvas.width  = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext("2d")?.drawImage(img, 0, 0);
                    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.9);

                    // Validate size — same 200 KB cap as the original plugin.
                    const base64   = jpegDataUrl.split(",")[1];
                    const byteSize = Math.ceil((base64.length * 3) / 4);
                    if (byteSize > 200 * 1024) {
                        showToast({ text: "Image must be under 200 KB after JPEG conversion.", variant: "critical" });
                        return;
                    }

                    if (await updateImage(jpegDataUrl)) {
                        showToast({ text: "Custom stream preview saved.", variant: "success" });
                    }
                };
                img.src = rawDataUrl;
            };
            reader.readAsDataURL(file);
        };

        input.click();
    }

    if (!streamPreview) return null;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>

            {/* Thumbnail preview area */}
            <div
                style={{
                    width: "100%",
                    minHeight: "80px",
                    background: "var(--background-secondary)",
                    borderRadius: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    padding: "8px",
                }}
            >
                {image ? (
                    <img
                        src={image}
                        alt="Custom stream preview"
                        style={{
                            maxWidth: "100%",
                            maxHeight: "180px",
                            borderRadius: "4px",
                            objectFit: "contain",
                        }}
                    />
                ) : (
                    <Text tag="p" size="sm" color="text-muted" style={{ textAlign: "center", margin: 0 }}>
                        No image set — Discord will use its normal stream thumbnail.
                    </Text>
                )}
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: "8px" }}>
                <Button type="button" size="small" onClick={openFilePicker}>
                    {image ? "Change Preview" : "Add Preview"}
                </Button>
                {image && (
                    <Button
                        type="button"
                        size="small"
                        variant="dangerPrimary"
                        onClick={() => {
                            void updateImage("").then(saved => {
                                if (saved) showToast({ text: "Custom stream preview removed.", variant: "success" });
                            });
                        }}
                    >
                        Remove Preview
                    </Button>
                )}
            </div>

        </div>
    );
}

// ─── plugin ───────────────────────────────────────────────────────────────────
export default definePlugin({
    name: "CustomStreamPreview",
    description:
        "Replaces Discord stream thumbnails with a configured static image.",
    authors: [{ id: 1288832011452153910n, name: "overocai" }],

    settings,

    start() {
        void hydratePreview().catch(() => {});
    },

    // Patch the preview upload manager rather than a particular declaration form.
    // Discord changes its minified variable declarations regularly.
    patches: [
        {
            find: '"ApplicationStreamPreviewUploadManager"',
            replacement: [
                {
                    // Replace the JPEG at its source when the capture path is used.
                    match: /([A-Za-z_$][\w$]*)\.toDataURL\("image\/jpeg"\)/,
                    replace: '$self._getStreamPreview($&)',
                },
                {
                    // Also replace the actual upload field. This covers code paths
                    // that already have a thumbnail or bypass canvas conversion.
                    match: /\{thumbnail:([A-Za-z_$][\w$]*)\}/g,
                    replace: '{thumbnail:$self._getStreamPreview($1)}',
                },
            ],
        },
    ],

    // ─── runtime hook ──────────────────────────────────────────────────────────
    _getStreamPreview(original: string): string {
        if (!settings.store.streamPreview) return original;

        if (!cachedPreview) {
            // With no custom image, keep the original preview rather than sending
            // an invalid empty upload. Thumbnail suppression needs a separate hook.
            return original;
        }

        return cachedPreview;
    },
});
