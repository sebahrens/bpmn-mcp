import * as esbuild from 'esbuild';

async function build() {
  try {
    console.log('Building MCP-BPMN server as CommonJS...');
    
    await esbuild.build({
      entryPoints: ['src/server/index.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',  // Use CommonJS format
      outfile: 'dist/server/bundle.cjs',
      external: [
        // Only external the things we really need to
        '@modelcontextprotocol/sdk/*'
      ],
      loader: {
        '.ts': 'ts'
      },
      target: 'node22',
      mainFields: ['main', 'module'],
      logLevel: 'info'
    });
    
    console.log('Build complete! Output: dist/server/bundle.cjs');
    console.log('Run with: node dist/server/bundle.cjs');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();