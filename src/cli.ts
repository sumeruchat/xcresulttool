#!/usr/bin/env node

import * as path from 'path'
import * as fs from 'fs'
import yargs from 'yargs'
import * as child_process from 'child_process'
import * as os from 'os'

interface CliArgs {
  path: string
  'show-passed-tests': boolean
  'show-code-coverage': boolean
  'debug': boolean
  'github-action': boolean
  [key: string]: unknown
}

async function main() {
  try {
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
      .option('github-action', {
        describe: 'Running as part of GitHub Action',
        type: 'boolean',
        default: false
      })
      .help()
      .alias('help', 'h')
      .version()
      .alias('version', 'v')
      .parseAsync() as CliArgs

    const bundlePath = argv.path;
    const debug = argv.debug;
    const isGitHubAction = argv['github-action'];
    
    if (debug) {
      console.log("Arguments parsed successfully");
      console.log(`Path: ${bundlePath}`);
      console.log(`Show passed tests: ${argv['show-passed-tests']}`);
      console.log(`Show code coverage: ${argv['show-code-coverage']}`);
      console.log(`Running as GitHub Action: ${isGitHubAction}`);
    }
    
    // Check if the file exists
    if (!fs.existsSync(bundlePath)) {
      console.error(`Error: File not found: ${bundlePath}`);
      process.exit(1);
    }

    // Verify the file is a valid xcresult bundle
    if (!bundlePath.endsWith('.xcresult') || !fs.statSync(bundlePath).isDirectory()) {
      console.error(`Error: Not a valid xcresult bundle: ${bundlePath}`);
      process.exit(1);
    }

    // Detect Xcode version
    let xcodeBuildOutput = '';
    try {
      xcodeBuildOutput = child_process.execSync('xcodebuild -version', { encoding: 'utf8' });
    } catch (error) {
      console.error("Failed to detect Xcode version. Assuming older version.");
      xcodeBuildOutput = "Xcode 15.0";
    }
    
    const xcodeVersionMatch = xcodeBuildOutput.match(/Xcode (\d+)\.(\d+)/);
    const isXcode16OrHigher = xcodeVersionMatch && parseInt(xcodeVersionMatch[1]) >= 16;
    
    if (debug) {
      console.log(`Detected Xcode version: ${xcodeBuildOutput.trim()}`);
      console.log(`Using ${isXcode16OrHigher ? 'new' : 'legacy'} command format`);
    }

    // Process test results
    let testSummary = '';
    let testDetails = '';
    
    try {
      if (isXcode16OrHigher) {
        // Use the new command format for Xcode 16+
        const testResultsCommand = `xcrun xcresulttool get test-results summary --path "${bundlePath}"`;
        if (debug) console.log(`Running: ${testResultsCommand}`);
        
        const testResultsOutput = child_process.execSync(testResultsCommand, { encoding: 'utf8' });
        const testResults = JSON.parse(testResultsOutput);
        
        // Generate test summary
        testSummary = "# Test Results Summary\n\n";
        testSummary += `- Total tests: ${testResults.totalTestCount}\n`;
        testSummary += `- Passed tests: ${testResults.passedTests}\n`;
        testSummary += `- Failed tests: ${testResults.failedTests}\n`;
        testSummary += `- Skipped tests: ${testResults.skippedTests}\n`;
        testSummary += `- Expected failures: ${testResults.expectedFailures}\n`;
        testSummary += `- Result: ${testResults.result}\n`;
        
        // Generate test details
        testDetails = "# Test Details\n\n";
        
        if (testResults.testFailures && Object.keys(testResults.testFailures).length > 0) {
          testDetails += "## Failed Tests\n\n";
          for (const failure of Object.values(testResults.testFailures)) {
            testDetails += `### ${failure.testName} (${failure.targetName})\n`;
            testDetails += `\`\`\`\n${failure.failureText}\n\`\`\`\n\n`;
          }
        }
        
        // Add device info
        if (testResults.devicesAndConfigurations && testResults.devicesAndConfigurations.device) {
          const device = testResults.devicesAndConfigurations.device;
          testDetails += "## Test Environment\n\n";
          testDetails += `- Device: ${device.deviceName}\n`;
          testDetails += `- Model: ${device.modelName}\n`;
          testDetails += `- OS Version: ${device.osVersion}\n`;
          testDetails += `- Architecture: ${device.architecture}\n`;
        }
      } else {
        // Use the legacy command format for older Xcode versions
        // Get the root ID from Info.plist
        const infoPlist = child_process.execSync(`plutil -p "${bundlePath}/Info.plist"`, { encoding: 'utf8' });
        const rootIdMatch = infoPlist.match(/"rootId"\s*=>\s*{\s*"hash"\s*=>\s*"([^"]+)"/);
        
        if (!rootIdMatch || !rootIdMatch[1]) {
          throw new Error("Could not find root ID in Info.plist");
        }
        
        const rootId = rootIdMatch[1];
        if (debug) console.log(`Using root ID: ${rootId}`);
        
        // Get test summary
        const summaryCommand = `xcrun xcresulttool get --format json --path "${bundlePath}" --id ${rootId}`;
        if (debug) console.log(`Running: ${summaryCommand}`);
        
        const summaryOutput = child_process.execSync(summaryCommand, { 
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024 // 50MB buffer
        });
        
        const summary = JSON.parse(summaryOutput);
        
        // Generate test summary
        testSummary = "# Test Results Summary\n\n";
        
        if (summary.actions && summary.actions.testsRef) {
          const testRefId = summary.actions.testsRef._value;
          if (debug) console.log(`Found test reference ID: ${testRefId}`);
          
          const testDetailsCommand = `xcrun xcresulttool get --format json --path "${bundlePath}" --id ${testRefId}`;
          if (debug) console.log(`Running: ${testDetailsCommand}`);
          
          const testDetailsOutput = child_process.execSync(testDetailsCommand, { 
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024
          });
          
          const testData = JSON.parse(testDetailsOutput);
          
          if (testData.summaries && testData.summaries.length > 0) {
            const testSummaryData = testData.summaries[0];
            testSummary += `- Total tests: ${testSummaryData.totals.testsCount._value}\n`;
            testSummary += `- Failed tests: ${testSummaryData.totals.failedCount._value}\n`;
            testSummary += `- Unexpected failures: ${testSummaryData.totals.unexpectedFailureCount._value}\n`;
            testSummary += `- Test duration: ${testSummaryData.duration._value.toFixed(2)} seconds\n`;
          }
          
          // Generate test details
          testDetails = "# Test Details\n\n";
          
          if (testData.tests && testData.tests.length > 0) {
            const processTests = (tests, indent = "") => {
              for (const test of tests) {
                if (test.name) {
                  testDetails += `${indent}## ${test.name._value}\n\n`;
                }
                
                if (test.subtests) {
                  for (const subtest of test.subtests) {
                    if (subtest.subtests) {
                      processTests([subtest], indent + "  ");
                    } else {
                      const testName = subtest.name?._value || "Unknown Test";
                      const testStatus = subtest.testStatus?._value || "unknown";
                      const duration = subtest.duration?._value?.toFixed(2) || "?";
                      
                      const statusEmoji = testStatus === "Success" ? "✅" : "❌";
                      testDetails += `${indent}- ${statusEmoji} **${testName}** (${duration}s)\n`;
                      
                      if (testStatus !== "Success" && subtest.summaryRef) {
                        testDetails += `${indent}  - Failure: Test failed\n`;
                      }
                    }
                  }
                }
              }
            };
            
            processTests(testData.tests);
          }
        } else {
          testSummary += "No test data found in the xcresult bundle.\n";
        }
      }
    } catch (error) {
      console.error(`Error processing test results: ${(error as Error).message}`);
      testSummary = "# Error Processing Test Results\n\n";
      testSummary += `Failed to process test results: ${(error as Error).message}\n`;
    }
    
    // Process code coverage if requested
    let coverageSummary = '';
    
    if (argv['show-code-coverage']) {
      try {
        if (isXcode16OrHigher) {
          // Use direct xccov approach for Xcode 16+
          const coverageCommand = `xcrun xccov view --report "${bundlePath}"`;
          if (debug) console.log(`Running: ${coverageCommand}`);
          
          const coverageOutput = child_process.execSync(coverageCommand, { 
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024
          });
          
          coverageSummary = "# Code Coverage Summary\n\n";
          coverageSummary += "```\n" + coverageOutput + "```\n\n";
          
          // Get detailed coverage for targets
          const targetsCommand = `xcrun xccov view --report --only-targets "${bundlePath}"`;
          if (debug) console.log(`Running: ${targetsCommand}`);
          
          const targetsOutput = child_process.execSync(targetsCommand, { encoding: 'utf8' });
          const targets = targetsOutput.trim().split('\n');
          
          if (targets.length > 0) {
            coverageSummary += "## Target Coverage Details\n\n";
            
            for (const target of targets) {
              const targetName = target.trim();
              if (!targetName) continue;
              
              const targetCommand = `xcrun xccov view --report --only-target "${targetName}" "${bundlePath}"`;
              if (debug) console.log(`Running: ${targetCommand}`);
              
              const targetOutput = child_process.execSync(targetCommand, { encoding: 'utf8' });
              coverageSummary += `### ${targetName}\n\n`;
              coverageSummary += "```\n" + targetOutput + "```\n\n";
            }
          }
        } else {
          // Use legacy approach for older Xcode versions
          // First get the coverage reference from the xcresult
          const infoPlist = child_process.execSync(`plutil -p "${bundlePath}/Info.plist"`, { encoding: 'utf8' });
          const rootIdMatch = infoPlist.match(/"rootId"\s*=>\s*{\s*"hash"\s*=>\s*"([^"]+)"/);
          
          if (!rootIdMatch || !rootIdMatch[1]) {
            throw new Error("Could not find root ID in Info.plist");
          }
          
          const rootId = rootIdMatch[1];
          
          // Get the coverage archive reference
          const summaryCommand = `xcrun xcresulttool get --format json --path "${bundlePath}" --id ${rootId}`;
          const summaryOutput = child_process.execSync(summaryCommand, { encoding: 'utf8' });
          const summary = JSON.parse(summaryOutput);
          
          if (summary.actions && summary.actions.codeCoverageInfo && summary.actions.codeCoverageInfo.archiveRef) {
            const archiveRef = summary.actions.codeCoverageInfo.archiveRef._value;
            if (debug) console.log(`Found coverage archive reference: ${archiveRef}`);
            
            // Create a temporary directory for the coverage archive
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcresult-coverage-'));
            if (debug) console.log(`Created temp directory: ${tempDir}`);
            
            // Export the coverage archive
            const exportCommand = `xcrun xcresulttool export --type directory --id ${archiveRef} --path "${bundlePath}" --output-path "${tempDir}"`;
            if (debug) console.log(`Running: ${exportCommand}`);
            
            child_process.execSync(exportCommand, { encoding: 'utf8' });
            
            // Get the coverage report
            const xccovCommand = `xcrun xccov view --report "${tempDir}"`;
            if (debug) console.log(`Running: ${xccovCommand}`);
            
            const coverageOutput = child_process.execSync(xccovCommand, { encoding: 'utf8' });
            
            coverageSummary = "# Code Coverage Summary\n\n";
            coverageSummary += "```\n" + coverageOutput + "```\n\n";
            
            // Clean up the temporary directory
            fs.rmdirSync(tempDir, { recursive: true });
            if (debug) console.log(`Removed temp directory: ${tempDir}`);
          } else {
            coverageSummary = "# Code Coverage Summary\n\n";
            coverageSummary += "No code coverage data found in the xcresult bundle.\n";
          }
        }
      } catch (error) {
        console.error(`Error processing code coverage: ${(error as Error).message}`);
        coverageSummary = "# Error Processing Code Coverage\n\n";
        coverageSummary += `Failed to process code coverage: ${(error as Error).message}\n`;
      }
    }
    
    // Output the report
    const fullReport = [testSummary, testDetails];
    
    if (argv['show-code-coverage']) {
      fullReport.push(coverageSummary);
    }
    
    // If running as GitHub Action, output in a format that can be parsed by the action
    if (isGitHubAction) {
      console.log(fullReport.join('\n'));
    } else {
      // For CLI usage, print with some formatting
      console.log('\n' + '='.repeat(80));
      console.log(testSummary);
      console.log('='.repeat(80) + '\n');
      console.log(testDetails);
      
      if (argv['show-code-coverage']) {
        console.log('\n' + '='.repeat(80));
        console.log(coverageSummary);
        console.log('='.repeat(80) + '\n');
      }
    }
    
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main(); 