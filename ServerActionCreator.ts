import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const API_URL = '${process.env.API_URL}'; // Keep as a string for TS output
const INPUT_FILE = 'openapi.yaml';
const OUTPUT_DIR = 'actions';

// Type definitions for OpenAPI components
interface OpenAPISchema {
    type?: string;
    $ref?: string;
    items?: OpenAPISchema;
    properties?: Record<string, OpenAPISchema>;
    required?: string[];
    enum?: any[];
    oneOf?: OpenAPISchema[];
    allOf?: OpenAPISchema[];
    anyOf?: OpenAPISchema[];
}

interface Parameter {
    name: string;
    in: 'query' | 'path' | 'header' | 'cookie';
    required?: boolean;
    schema?: OpenAPISchema;
}

interface RequestBody {
    required?: boolean;
    content: {
        'application/json'?: {
            schema: OpenAPISchema;
        };
    };
}

interface Response {
    description: string;
    content?: {
        'application/json'?: {
            schema: OpenAPISchema;
        };
    };
}

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Load OpenAPI YAML
const doc = yaml.load(fs.readFileSync(INPUT_FILE, 'utf8')) as any;
const paths = doc.paths || {};

// Function to resolve $ref in schema
function resolveRef(ref: string, doc: any): OpenAPISchema {
    const parts = ref.replace('#/', '').split('/');
    let current = doc;
    for (const part of parts) {
        current = current[part];
    }
    return current;
}

// Function to convert OpenAPI schema to TypeScript type
function schemaToTS(schema: OpenAPISchema, doc: any): string {
    if (!schema) return 'any';
    
    if (schema.$ref) {
        const resolved = resolveRef(schema.$ref, doc);
        return schemaToTS(resolved, doc);
    }
    
    switch (schema.type) {
        case 'string':
            return 'string';
        case 'integer':
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'array':
            return `Array<${schemaToTS(schema.items!, doc)}>`;
        case 'object':
            if (!schema.properties) return 'Record<string, any>';
            const required = schema.required || [];
            const props = Object.entries(schema.properties).map(([key, value]) => {
                const isRequired = required.includes(key);
                return `${key}${isRequired ? '' : '?'}: ${schemaToTS(value, doc)}`;
            });
            return `{${props.join('; ')}}`;
        default:
            return 'any';
    }
}

// Function to generate TypeScript function
const generateFunction = (route: string, method: string, operation: any): string => {
    let functionName = operation.operationId || `${method}${route.replace(/\W+/g, '_')}`;
    functionName = functionName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); // Convert to camelCase
    
    const parameters = operation.parameters || [];
    const pathParams = parameters.filter((p: Parameter) => p.in === 'path');
    const queryParams = parameters.filter((p: Parameter) => p.in === 'query');
    
    const requestBody = operation.requestBody as RequestBody | undefined;
    const responseSchema = operation.responses?.['200']?.content?.['application/json']?.schema;
    
    // Generate type signatures
    const pathParamTypes = pathParams.map((p: Parameter) =>
        `${p.name}: ${schemaToTS(p.schema!, doc)}`
    ).join('; ');
    
    const queryParamTypes = queryParams.map((p: Parameter) =>
        `${p.name}${p.required ? '' : '?'}: ${schemaToTS(p.schema!, doc)}`
    ).join('; ');
    
    const requestBodyType = requestBody
        ? schemaToTS(requestBody.content['application/json']?.schema!, doc)
        : 'undefined';
    
    const responseType = responseSchema
        ? schemaToTS(responseSchema, doc)
        : 'any';
    
    // Build parameter signature
    let paramSignature = '';
    if (pathParams.length) {
        paramSignature += `{ ${pathParams.map(p => p.name).join(', ')} }: { ${pathParamTypes} }`;
    }
    if (queryParams.length) {
        paramSignature += paramSignature ? `, query: { ${queryParamTypes} }` : `query: { ${queryParamTypes} }`;
    }
    if (requestBody) {
        paramSignature += paramSignature ? `, body: ${requestBodyType}` : `body: ${requestBodyType}`;
    }
    paramSignature = paramSignature || '_?: void';
    
    // Build URL construction
    let url = `${API_URL}${route}`;
    pathParams.forEach(p => {
        url = url.replace(`{${p.name}}`, `\${${p.name}}`);
    });
    
    const queryHandling = queryParams.length
        ? 'const queryStr = new URLSearchParams(Object.entries(query).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString(); url += queryStr ? `?${queryStr}` : "";'
        : '';
    
    const bodyHandling = requestBody
        ? 'const options: RequestInit = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };'
        : 'const options: RequestInit = {};';
    
    return `'use server';

/**
 * ${operation.summary || ''}
 * ${operation.description || ''}
 */
export async function ${functionName}(${paramSignature}): Promise<${responseType} | null> {
  try {
    let url = \`${url}\`;
    ${queryHandling}
    ${bodyHandling}
    const res = await fetch(url, options);
    
    if (!res.ok) {
      console.error(\`API error: ${method.toUpperCase()} \${url} \${res.status}\`);
      return null;
    }
    
    return await res.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}`;
};

// Generate files for each endpoint
for (const [route, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
        const functionCode = generateFunction(route, method, operation);
        let fileName = operation.operationId || `${method}${route.replace(/\W+/g, '_')}`;
        fileName = fileName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); // Convert to camelCase
        fs.writeFileSync(path.join(OUTPUT_DIR, `${fileName}.ts`), functionCode, 'utf8');
    }
}

console.log('✅ Server actions generated successfully!');
