import fetch from 'node-fetch';
import { readFileSync } from 'fs-extra';

const [url] = process.argv.slice(2);

if (url.match(/^https?:\/\//)) {
    fetch(url).then(resp => {
        if (!resp.ok) throw new Error(`${resp.status}: ${resp.statusText}`);
        return resp.text();
    }).then(ts => {
        const out = {
            local: url,
            __code: ts
        };
        process.stdout.write(JSON.stringify(out), () => {
            process.exit(0);
        })
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    const data = readFileSync(url, { encoding: "utf-8" });
    const out = {
        local: url,
        __code: data
    };
    process.stdout.write(JSON.stringify(out), () => {
        process.exit(0);
    })
}