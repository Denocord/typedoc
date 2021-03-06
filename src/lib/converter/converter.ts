import * as ts from 'typescript';
import * as _ts from '../ts-internal';
import * as _ from 'lodash';

import { Application } from '../application';
import { Reflection, Type, ProjectReflection } from '../models/index';
import { Context } from './context';
import { ConverterComponent, ConverterNodeComponent, ConverterTypeComponent, TypeTypeConverter, TypeNodeConverter } from './components';
import { Component, ChildableComponent, ComponentClass } from '../utils/component';
import { BindOption } from '../utils';
import { normalizePath } from '../utils/fs';
import { createMinimatch } from '../utils/paths';

import { DenoCompilerHost } from './deno-compiler-host';

// https://github.com/denoland/deno/blob/da98f9e3a174a304b0a83391fa61fcfdba0fc668/cli/tsc/99_main_compiler.js
const ignoredDiagnostics = [
    // TS2306: File 'file:///Users/rld/src/deno/cli/tests/subdir/amd_like.js' is
    // not a module.
    2306,
    // TS1375: 'await' expressions are only allowed at the top level of a file
    // when that file is a module, but this file has no imports or exports.
    // Consider adding an empty 'export {}' to make this file a module.
    1375,
    // TS1103: 'for-await-of' statement is only allowed within an async function
    // or async generator.
    1103,
    // TS2691: An import path cannot end with a '.ts' extension. Consider
    // importing 'bad-module' instead.
    2691,
    // TS5009: Cannot find the common subdirectory path for the input files.
    5009,
    // TS5055: Cannot write file
    // 'http://localhost:4545/cli/tests/subdir/mt_application_x_javascript.j4.js'
    // because it would overwrite input file.
    5055,
    // TypeScript is overly opinionated that only CommonJS modules kinds can
    // support JSON imports.  Allegedly this was fixed in
    // Microsoft/TypeScript#26825 but that doesn't seem to be working here,
    // so we will ignore complaints about this compiler setting.
    5070,
    // TS7016: Could not find a declaration file for module '...'. '...'
    // implicitly has an 'any' type.  This is due to `allowJs` being off by
    // default but importing of a JavaScript module.
    7016,
  ];
/**
 * Result structure of the [[Converter.convert]] method.
 */
export interface ConverterResult {
    /**
     * An array containing all errors generated by the TypeScript compiler.
     */
    errors: ReadonlyArray<ts.Diagnostic>;

    /**
     * The resulting project reflection.
     */
    project: ProjectReflection;
}

/**
 * Compiles source files using TypeScript and converts compiler symbols to reflections.
 */
@Component({name: 'converter', internal: true, childClass: ConverterComponent})
export class Converter extends ChildableComponent<Application, ConverterComponent> {
    /**
     * The human readable name of the project. Used within the templates to set the title of the document.
     */
    @BindOption('name')
    name!: string;

    @BindOption('externalPattern')
    externalPattern!: Array<string>;

    @BindOption('includeDeclarations')
    includeDeclarations!: boolean;

    @BindOption('excludeExternals')
    excludeExternals!: boolean;

    @BindOption('excludeNotExported')
    excludeNotExported!: boolean;

    @BindOption('excludeNotDocumented')
    excludeNotDocumented!: boolean;

    @BindOption('excludePrivate')
    excludePrivate!: boolean;

    @BindOption('excludeProtected')
    excludeProtected!: boolean;

    /**
     * Defined in the initialize method
     */
    private nodeConverters!: {[syntaxKind: number]: ConverterNodeComponent<ts.Node>};

    /**
     * Defined in the initialize method
     */
    private typeNodeConverters!: TypeNodeConverter<ts.Type, ts.Node>[];

    /**
     * Defined in the initialize method
     */
    private typeTypeConverters!: TypeTypeConverter<ts.Type>[];

    /**
     * General events
     */

    /**
     * Triggered when the converter begins converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_BEGIN = 'begin';

    /**
     * Triggered when the converter has finished converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_END = 'end';

    /**
     * Factory events
     */

    /**
     * Triggered when the converter begins converting a source file.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FILE_BEGIN = 'fileBegin';

    /**
     * Triggered when the converter has created a declaration reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_DECLARATION = 'createDeclaration';

    /**
     * Triggered when the converter has created a signature reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_SIGNATURE = 'createSignature';

    /**
     * Triggered when the converter has created a parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_PARAMETER = 'createParameter';

    /**
     * Triggered when the converter has created a type parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_TYPE_PARAMETER = 'createTypeParameter';

    /**
     * Triggered when the converter has found a function implementation.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FUNCTION_IMPLEMENTATION = 'functionImplementation';

    /**
     * Resolve events
     */

    /**
     * Triggered when the converter begins resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_BEGIN = 'resolveBegin';

    /**
     * Triggered when the converter resolves a reflection.
     * The listener should implement [[IConverterResolveCallback]].
     * @event
     */
    static EVENT_RESOLVE = 'resolveReflection';

    /**
     * Triggered when the converter has finished resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_END = 'resolveEnd';

    /**
     * Create a new Converter instance.
     *
     * @param application  The application instance this converter relies on. The application
     *   must expose the settings that should be used and serves as a global logging endpoint.
     */
    initialize() {
        this.nodeConverters = {};
        this.typeTypeConverters = [];
        this.typeNodeConverters = [];
    }

    addComponent<T extends ConverterComponent & Component>(name: string, componentClass: T | ComponentClass<T>): T {
        const component = super.addComponent(name, componentClass);
        if (component instanceof ConverterNodeComponent) {
            this.addNodeConverter(component);
        } else if (component instanceof ConverterTypeComponent) {
            this.addTypeConverter(component);
        }

        return component;
    }

    private addNodeConverter(converter: ConverterNodeComponent<any>) {
        for (const supports of converter.supports) {
            this.nodeConverters[supports] = converter;
        }
    }

    private addTypeConverter(converter: ConverterTypeComponent) {
        if ('supportsNode' in converter && 'convertNode' in converter) {
            this.typeNodeConverters.push(<TypeNodeConverter<any, any>> converter);
            this.typeNodeConverters.sort((a, b) => b.priority - a.priority);
        }

        if ('supportsType' in converter && 'convertType' in converter) {
            this.typeTypeConverters.push(<TypeTypeConverter<any>> converter);
            this.typeTypeConverters.sort((a, b) => b.priority - a.priority);
        }
    }

    removeComponent(name: string): ConverterComponent | undefined {
        const component = super.removeComponent(name);
        if (component instanceof ConverterNodeComponent) {
            this.removeNodeConverter(component);
        } else if (component instanceof ConverterTypeComponent) {
            this.removeTypeConverter(component);
        }

        return component;
    }

    private removeNodeConverter(converter: ConverterNodeComponent<any>) {
        const converters = this.nodeConverters;
        const keys = _.keys(this.nodeConverters);
        for (const key of keys) {
            if (converters[key] === converter) {
                delete converters[key];
            }
        }
    }

    private removeTypeConverter(converter: ConverterTypeComponent) {
        const typeIndex = this.typeTypeConverters.indexOf(<any> converter);
        if (typeIndex !== -1) {
            this.typeTypeConverters.splice(typeIndex, 1);
        }

        const nodeIndex = this.typeNodeConverters.indexOf(<any> converter);
        if (nodeIndex !== -1) {
            this.typeNodeConverters.splice(nodeIndex, 1);
        }
    }

    removeAllComponents() {
        super.removeAllComponents();

        this.nodeConverters = {};
        this.typeTypeConverters = [];
        this.typeNodeConverters = [];
    }

    /**
     * Compile the given source files and create a project reflection for them.
     *
     * @param fileNames  Array of the file names that should be compiled.
     */
    convert(fileNames: string[]): ConverterResult {
        // JSON files should never result in extra members in the documentation, but need to be included so that TS
        // can find them.
        const normalizedFiles = fileNames.map(normalizePath).filter(path => !path.endsWith('.json'));

        const program = ts.createProgram({
            rootNames: normalizedFiles,
            options: _.merge({ // default compile options taken from Deno sources
                allowJs: true,
                allowNonTsExtensions: true,
                checkJs: false,
                esModuleInterop: true,
                jsx: ts.JsxEmit.React,
                module: ts.ModuleKind.ESNext,
                sourceMap: true,
                strict: true,
                removeComments: true,
                target: ts.ScriptTarget.ESNext,
                // TODO: Support both workers and regular files
                lib: ["lib.deno.window.d.ts", "lib.deno.unstable.d.ts"],
            }, this.application.options.getCompilerOptions()),
            host: new DenoCompilerHost(),
        });
        const checker = program.getTypeChecker();
        const context = new Context(this, normalizedFiles, checker, program);

        this.trigger(Converter.EVENT_BEGIN, context);

        const errors = this.compile(context);
        const project = this.resolve(context);

        const dangling = project.getDanglingReferences();
        if (dangling.length) {
            this.owner.logger.warn([
                'Some names refer to reflections that do not exist.',
                'This can be caused by exporting a reflection only under a different name than it is declared when excludeNotExported is set',
                'or by a plugin removing reflections without removing references. The names that cannot be resolved are:',
                ...dangling
            ].join('\n'));
        }

        this.trigger(Converter.EVENT_END, context);

        return {
            errors: errors,
            project: project
        };
    }

    /**
     * Analyze the given node and create a suitable reflection.
     *
     * This function checks the kind of the node and delegates to the matching function implementation.
     *
     * @param context  The context object describing the current state the converter is in.
     * @param node     The compiler node that should be analyzed.
     * @return The resulting reflection or undefined.
     */
    convertNode(context: Context, node: ts.Node): Reflection | undefined {
        if (context.visitStack.includes(node)) {
            return;
        }

        const oldVisitStack = context.visitStack;
        context.visitStack = oldVisitStack.slice();
        context.visitStack.push(node);

        let result: Reflection | undefined;
        if (node.kind in this.nodeConverters) {
            result = this.nodeConverters[node.kind].convert(context, node);
        }

        context.visitStack = oldVisitStack;
        return result;
    }

    /**
     * Convert the given TypeScript type into its TypeDoc type reflection.
     *
     * @param context  The context object describing the current state the converter is in.
     * @param node  The node whose type should be reflected.
     * @param type  The type of the node if already known.
     * @returns The TypeDoc type reflection representing the given node and type.
     */
    convertType(context: Context, node?: ts.Node, type?: ts.Type): Type | undefined {
        // Run all node based type conversions
        if (node) {
            type = type || context.getTypeAtLocation(node);

            for (const converter of this.typeNodeConverters) {
                if (converter.supportsNode(context, node, type)) {
                    return converter.convertNode(context, node, type);
                }
            }
        }

        // Run all type based type conversions
        if (type) {
            for (const converter of this.typeTypeConverters) {
                if (converter.supportsType(context, type)) {
                    return converter.convertType(context, type);
                }
            }
        }
    }

    /**
     * Helper function to convert multiple types at once, filtering out types which fail to convert.
     *
     * @param context
     * @param nodes
     */
    convertTypes(context: Context, nodes: ReadonlyArray<ts.Node> = [], types: ReadonlyArray<ts.Type> = []): Type[] {
        const result: Type[] = [];
        _.zip(nodes, types).forEach(([node, type]) => {
            const converted = this.convertType(context, node, type);
            if (converted) {
                result.push(converted);
            }
        });
        return result;
    }

    /**
     * Compile the files within the given context and convert the compiler symbols to reflections.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns An array containing all errors generated by the TypeScript compiler.
     */
    private compile(context: Context): ReadonlyArray<ts.Diagnostic> {
        const program = context.program;
        const exclude = createMinimatch(this.application.exclude || []);
        const isExcluded = (file: ts.SourceFile) => exclude.some(mm => mm.match(file.fileName));
        const includedSourceFiles = program.getSourceFiles()
            .filter(file => !isExcluded(file));

        const errors = this.getCompilerErrors(program, includedSourceFiles);
        if (errors.length) {
            return errors;
        }

        includedSourceFiles.forEach((sourceFile) => {
            this.convertNode(context, sourceFile);
        });

        return [];
    }

    /**
     * Resolve the project within the given context.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns The final project reflection.
     */
    private resolve(context: Context): ProjectReflection {
        this.trigger(Converter.EVENT_RESOLVE_BEGIN, context);
        const project = context.project;

        for (const id in project.reflections) {
            if (!project.reflections.hasOwnProperty(id)) {
                continue;
            }
            this.trigger(Converter.EVENT_RESOLVE, context, project.reflections[id]);
        }

        this.trigger(Converter.EVENT_RESOLVE_END, context);
        return project;
    }

    private getCompilerErrors(program: ts.Program, includedSourceFiles: readonly ts.SourceFile[]): ReadonlyArray<ts.Diagnostic> {
        if (this.application.ignoreCompilerErrors) {
            return [];
        }

        const isRelevantError = (diag: ts.Diagnostic) => {
            if (!diag.file || includedSourceFiles.includes(diag.file)) return !ignoredDiagnostics.includes(diag.code);
        }

        let diagnostics = program.getOptionsDiagnostics().filter(isRelevantError);
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getSyntacticDiagnostics().filter(isRelevantError);
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getGlobalDiagnostics().filter(isRelevantError);
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getSemanticDiagnostics().filter(isRelevantError);
        if (diagnostics.length) {
            return diagnostics;
        }

        return [];
    }

    /**
     * Return the basename of the default library that should be used.
     *
     * @returns The basename of the default library.
     */
    getDefaultLib(): string {
        return ts.getDefaultLibFileName(this.application.options.getCompilerOptions());
    }
}
