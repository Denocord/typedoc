import * as ts from 'typescript';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs-extra';
import { resolve, basename } from 'path';
import { URL } from 'url';

// https://github.com/denoland/deno/blob/da98f9e3a174a304b0a83391fa61fcfdba0fc668/cli/tsc/99_main_compiler.js#L779
const libs = (<any>ts).libs;
const libMap = (<any>ts).libMap;
libs.push("deno.ns", "deno.window", "deno.worker", "deno.shared_globals");
libMap.set("deno.ns", "lib.deno.ns.d.ts");
libMap.set("deno.web", "../../op_crates/web/lib.deno_web.d.ts");
libMap.set("deno.window", "lib.deno.window.d.ts");
libMap.set("deno.worker", "lib.deno.worker.d.ts");
libMap.set("deno.shared_globals", "lib.deno.shared_globals.d.ts");
libMap.set("deno.unstable", "lib.deno.unstable.d.ts");

export class DenoCompilerHost implements ts.CompilerHost {
    private emitMap: Record<string, {
        filename: string;
        contents: string;
    }> = {};
    private cache: Record<string, ts.SourceFile> = {};

    private stripFileName(fileName: string) {
        if (fileName.match(/\.(j|t)sx?\.(j|t)sx?$/)) {
            return fileName.replace(/\.(j|t)sx?$/, "");
        }
        return fileName;
    }

    __getModuleInfo(fileName: string): any {
        if (!fileName.match(/^https?:\/\//)) {
            if (!existsSync(fileName)) return {
                local: fileName,
                __code: ""
            };
            return {
                local: fileName,
                __code: readFileSync(fileName, { encoding: "utf-8" })
            };
        }
        const { status, stdout, stderr } = spawnSync("node", [`${__dirname}/standalone-fetch-file`, fileName]);
        if (status) {
            const err = new Error("cannot load appropriate files");
            console.error(stderr.toString());
            throw err;
        } else {
            const json = JSON.parse(stdout);
            return json;
        }
    }

    getSourceFile(fileName: string,
        languageVersion: ts.ScriptTarget,
        onError?: ((message: string) => void) | undefined,
        shouldCreateNewSourceFile?: boolean | undefined): ts.SourceFile | undefined {
        if (shouldCreateNewSourceFile) throw new Error("should not create new sources");
        if (this.cache[fileName]) return this.cache[fileName];
        const json = this.__getModuleInfo(this.stripFileName(fileName));
        return this.cache[fileName] = ts.createSourceFile(fileName, json.__code, languageVersion);
        
    }
    getDefaultLibFileName(options: ts.CompilerOptions): string {
        return "https://raw.githubusercontent.com/denoland/deno/master/cli/dts/lib.deno.ns.d.ts";
    }

    getCurrentDirectory(): string {
        return "";
    }
    getCanonicalFileName(fileName: string): string {
        return fileName;
    }
    useCaseSensitiveFileNames(): boolean {
        return true;
    }
    getNewLine(): string {
        return "\n";
    }
    fileExists(fileName: string): boolean {
        if (this.cache[fileName]) return true;
        if (!this.stripFileName(fileName).match(/\.(j|t)sx?$/)) return false;
        const json = this.__getModuleInfo(this.stripFileName(fileName));
        return !!json.__code || existsSync(json.local);
    }
    readFile(fileName: string): string | undefined {
        const json = this.__getModuleInfo(this.stripFileName(fileName));
        return readFileSync(json.local, { encoding: "utf-8" });
    }
    writeFile(fileName: string, data: string, _writeBOM: unknown, _onError: unknown, sources?: readonly ts.SourceFile[]) {
        this.emitMap[fileName] = {
            filename: sources?.[0].fileName ?? "unknown.ts",
            contents: data,
        }
    }
    resolveModuleNames(moduleNames: string[], container: string): (ts.ResolvedModule | undefined)[] {
        return moduleNames.map<ts.ResolvedModule>(spec => {
            if (spec.match(/^https?:\/\//)) {
                return {
                    resolvedFileName: spec,
                    isExternalLibraryImport: true
                }
            } else {
                if (container.match(/^https?:\/\//)) {
                    const url = new URL(spec, container);
                    return {
                        resolvedFileName: url.toString(),
                        isExternalLibraryImport: true
                    };
                }
                return {
                    resolvedFileName: resolve(container, '..', spec),
                    // TODO(TTtie): this shouldn't be forced to a single standard
                    isExternalLibraryImport: basename(spec) === "deps.ts"
                };
            }
        });
    }

}