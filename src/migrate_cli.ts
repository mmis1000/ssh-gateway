import { resolve } from "path";
import { describePlan, planMigration, recoverInterruptedMigration, runMigration } from "./migrate";
import { readStoreVersion, STORE_VERSION } from "./store";
import { LEGACY_HOST_KEY_DIR, readConfig } from "./config";

/** npm run migrate [-- --dry-run], the server also migrates on start */
async function main() {
    const dryRun = process.argv.includes('--dry-run')
    const config = await readConfig()
    const saveDir = resolve(config.saveDir)

    if (!dryRun) await recoverInterruptedMigration(saveDir)

    const version = await readStoreVersion(saveDir)
    if (version !== null) {
        console.log(`${saveDir} already uses storage version ${version}${version === STORE_VERSION ? ', nothing to do' : ''}`)
        return
    }

    const plan = await planMigration(saveDir, LEGACY_HOST_KEY_DIR)
    if (!plan) {
        console.log(`${saveDir} is empty, a new store is created when the server starts`)
    } else if (dryRun) {
        console.log(describePlan(plan))
        console.log('Dry run, nothing was changed')
    } else {
        await runMigration(plan)
    }
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
