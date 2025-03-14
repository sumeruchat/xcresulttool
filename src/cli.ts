#!/usr/bin/env node

import * as path from 'path'
import * as fs from 'fs'
import yargs from 'yargs'
import {Formatter} from './formatter'
import * as exec from '@actions/exec'

interface CliArgs {
  path: string
  'show-passed-tests': boolean
  'show-code-coverage': boolean
  'debug': boolean
  [key: string]: unknown
}

async function main() {
  const argv = await yargs
    .usage('Usage: $0 [options]')
    .option('path', {
      describe: 'Path to the xcresult bundle',
      type: 'string',
      demandOption: true
    })
    .option('show-passed-tests', {
      describe: 'Show passed tests',
      type: 'boolean',
      default: true
    })
    .option('show-code-coverage', {
      describe: 'Whether to show code coverage',
      type: 'boolean',
      default: true
    })
    .option('debug', {
      describe: 'Show debug information',
      type: 'boolean',
      default: false
    })
    .help()
    .alias('help', 'h')
    .version()
    .alias('version', 'v')
    .parseAsync() as CliArgs

  try {
    const bundlePath = argv.path
    const debug = argv.debug
    
    // Check if the file exists
    if (!fs.existsSync(bundlePath)) {
      console.error(`Error: File not found: ${bundlePath}`)
      process.exit(1)
    }

    // Verify the file is a valid xcresult bundle
    if (!bundlePath.endsWith('.xcresult') || !fs.statSync(bundlePath).isDirectory()) {
      console.error(`Error: Not a valid xcresult bundle: ${bundlePath}`)
      process.exit(1)
    }

    if (debug) {
      console.log('Checking xcrun version...')
      await exec.exec('xcrun', ['--version'], { silent: false })
      
      console.log('Checking xcresulttool version...')
      await exec.exec('xcrun', ['xcresulttool', '--version'], { silent: false })
    }

    // Determine Xcode version to handle command differences
    let xcodeBuildOutput = ''
    await exec.exec('xcodebuild', ['-version'], { 
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          xcodeBuildOutput += data.toString()
        }
      }
    })
    
    const xcodeVersionMatch = xcodeBuildOutput.match(/Xcode (\d+)\.(\d+)/)
    const isXcode16OrHigher = xcodeVersionMatch && parseInt(xcodeVersionMatch[1]) >= 16
    
    if (debug) {
      console.log(`Detected Xcode version: ${xcodeBuildOutput.trim()}`)
      console.log(`Using ${isXcode16OrHigher ? 'new' : 'legacy'} xcresulttool command format`)
    }

    // Modify the formatter to use the correct xcrun command format
    // This is a temporary patch until we can update the formatter properly
    const originalExec = exec.exec
    exec.exec = async function(commandLine: string, args?: string[], options?: exec.ExecOptions): Promise<number> {
      if (commandLine === 'xcrun' && args && args[0] === 'xcresulttool' && args[1] === 'get') {
        if (isXcode16OrHigher) {
          // Insert 'object' and '--legacy' for Xcode 16+
          const newArgs = [...args]
          newArgs.splice(1, 1, 'get', 'object', '--legacy')
          if (debug) {
            console.log(`Modified command: xcrun ${newArgs.join(' ')}`)
          }
          return originalExec(commandLine, newArgs, options)
        }
      }
      return originalExec(commandLine, args, options)
    }

    if (debug) {
      console.log('Processing xcresult bundle...')
    }

    const formatter = new Formatter(bundlePath)
    const report = await formatter.format({
      showPassedTests: argv['show-passed-tests'],
      showCodeCoverage: argv['show-code-coverage']
    })

    // Restore original exec function
    exec.exec = originalExec

    console.log(report.reportSummary)
    console.log(report.reportDetail)
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    if (error instanceof Error && error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

main() 