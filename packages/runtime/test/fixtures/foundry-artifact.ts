// Captured from Forge 1.7.1 / solc 0.8.37 compiling this synthetic test:
// contract Harness { function testExample() public pure { assert(true); } }
// Keep the compiler's artifact structure in regression tests without requiring
// a Forge executable or a compiler download in the runtime test environment.
export const foundryHarnessArtifact = {
  abi: [
    {
      type: "function",
      name: "testExample",
      inputs: [],
      outputs: [],
      stateMutability: "pure"
    }
  ],
  bytecode: {
    object:
      "0x6080604052348015600e575f5ffd5b5060a380601a5f395ff3fe6080604052348015600e575f5ffd5b50600436106026575f3560e01c80633f5a4a2a14602a575b5f5ffd5b60306032565b005b6001603e57603d6040565b5b565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52600160045260245ffdfea2646970667358221220d43bd887622029247fcfcb18cf2da1bb8e8b32d25cbf9e37d5881e92d60720bd64736f6c63430008250033",
    sourceMap: "56:79:1:-:0;;;;;;;;;;;;;;;;;;;",
    linkReferences: {}
  },
  deployedBytecode: {
    object:
      "0x6080604052348015600e575f5ffd5b50600436106026575f3560e01c80633f5a4a2a14602a575b5f5ffd5b60306032565b005b6001603e57603d6040565b5b565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52600160045260245ffdfea2646970667358221220d43bd887622029247fcfcb18cf2da1bb8e8b32d25cbf9e37d5881e92d60720bd64736f6c63430008250033",
    sourceMap:
      "56:79:1:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;79:54;;;:::i;:::-;;;125:4;118:12;;;;:::i;:::-;;79:54::o;7:180:2:-;55:77;52:1;45:88;152:4;149:1;142:15;176:4;173:1;166:15",
    linkReferences: {}
  },
  methodIdentifiers: {
    "testExample()": "3f5a4a2a"
  },
  rawMetadata:
    '{"compiler":{"version":"0.8.37+commit.f401782d"},"language":"Solidity","output":{"abi":[{"inputs":[],"name":"testExample","outputs":[],"stateMutability":"pure","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"test/Harness.t.sol":"Harness"},"evmVersion":"osaka","libraries":{},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":false,"runs":200},"remappings":[]},"sources":{"test/Harness.t.sol":{"keccak256":"0x9cb160a30924af445aa5ff55a744a9e1dc01ab5d6266767f59d007147030212e","license":"MIT","urls":["bzz-raw://a0c4bf7185513d717cabd37e06c1d58b759669af36e59bd2dc9fcb2fc35e7359","dweb:/ipfs/QmSogmbrsgc1QQDpG6uymmUcWcHWXbcEBZY91XPzEKWLTa"]}},"version":1}',
  metadata: {
    compiler: {
      version: "0.8.37+commit.f401782d"
    },
    language: "Solidity",
    output: {
      abi: [
        {
          inputs: [],
          stateMutability: "pure",
          type: "function",
          name: "testExample"
        }
      ],
      devdoc: {
        kind: "dev",
        methods: {},
        version: 1
      },
      userdoc: {
        kind: "user",
        methods: {},
        version: 1
      }
    },
    settings: {
      remappings: [],
      optimizer: {
        enabled: false,
        runs: 200
      },
      metadata: {
        bytecodeHash: "ipfs"
      },
      compilationTarget: {
        "test/Harness.t.sol": "Harness"
      },
      evmVersion: "osaka",
      libraries: {}
    },
    sources: {
      "test/Harness.t.sol": {
        keccak256: "0x9cb160a30924af445aa5ff55a744a9e1dc01ab5d6266767f59d007147030212e",
        urls: [
          "bzz-raw://a0c4bf7185513d717cabd37e06c1d58b759669af36e59bd2dc9fcb2fc35e7359",
          "dweb:/ipfs/QmSogmbrsgc1QQDpG6uymmUcWcHWXbcEBZY91XPzEKWLTa"
        ],
        license: "MIT"
      }
    },
    version: 1
  },
  id: 1
};
