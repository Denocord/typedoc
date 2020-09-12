import { Cache } from "@denocord/typedoc-cache";
import { readFileSync } from 'fs-extra';
const [url] = process.argv.slice(2);
Cache.fetch(url).then(file => {
    return readFileSync(file.path, { encoding: "utf-8" });
}).then(code => {
    const out = {
        local: url,
        __code: code
    };
    process.stdout.write(JSON.stringify(out), () => {
        process.exit(0);
    })
}).catch(err => {
    console.error(err);
    process.exit(1);
})