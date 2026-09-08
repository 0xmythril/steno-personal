import { getSettings } from '@/lib/services/settings'
import { TRANSCRIPTION_CATALOG, VISION_CATALOG, DEFAULT_VISION_MODEL, DEFAULT_TRANSCRIPTION_MODEL } from '@/lib/services/analysis-catalog'
import { ModelField } from './model-field'
import { clearOpenrouterKeyAction, saveOpenrouterKeyAction, updateEnrichmentAction } from './actions'

// Separate forms share one card; numbered sections make their save actions clear.
export async function EnrichmentSection() {
  const s = await getSettings()
  return (
    <section className="card" id="enrichment">
      <h2>Enrichment</h2>
      <p className="muted">Make text in images and voice notes searchable. Requires an OpenRouter key.</p>
      <p className="help">Off by default. When enabled, files are sent through OpenRouter to the provider shown below.</p>

      <div className="settings-subsection">
        <h3>1. Add an OpenRouter key</h3>
        <p className="help">Stored encrypted on this instance and never displayed after saving.</p>
        {s.hasOpenrouterKey ? (
          <>
            <span className="token"><code>OpenRouter key saved</code></span>
            <form action={clearOpenrouterKeyAction}>
              <button type="submit" className="small danger">Clear key</button>
            </form>
            <p className="help">Clearing the key also turns enrichment off.</p>
          </>
        ) : (
          <form action={saveOpenrouterKeyAction} className="row">
            <label className="field">
              <span>OpenRouter key</span>
              <input type="password" name="openrouterKey" autoComplete="off" spellCheck={false} placeholder="sk-or-…" required />
            </label>
            <button type="submit" className="primary">Save key</button>
          </form>
        )}
      </div>

      <div className="settings-subsection">
        <h3>2. Choose what to process</h3>
        {!s.hasOpenrouterKey && <p className="help">Save a key above to enable these features.</p>}
        <form action={updateEnrichmentAction} className="stack">
          <label className="check">
            <input key={`images:${s.hasOpenrouterKey}:${s.analyzeImages}`} type="checkbox" name="analyzeImages" defaultChecked={s.analyzeImages} disabled={!s.hasOpenrouterKey} />
            Read text from images
          </label>
          <label className="check">
            <input key={`audio:${s.hasOpenrouterKey}:${s.analyzeAudio}`} type="checkbox" name="analyzeAudio" defaultChecked={s.analyzeAudio} disabled={!s.hasOpenrouterKey} />
            Transcribe voice notes
          </label>
          <ModelField label="Image model" name="visionModel" options={VISION_CATALOG} selected={s.visionModel ?? DEFAULT_VISION_MODEL} />
          <ModelField label="Transcription model" name="transcriptionModel" options={TRANSCRIPTION_CATALOG} selected={s.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL} />
          <div className="actions"><button type="submit" className="primary" disabled={!s.hasOpenrouterKey}>Save enrichment settings</button></div>
        </form>
      </div>
    </section>
  )
}
