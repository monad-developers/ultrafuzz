# SCFuzzBench

This directory contains scorer-side ground truth for targets sourced from
[SCFuzzBench](https://scfuzzbench.com/). Each target keeps its labels under a
dedicated directory so additional SCFuzzBench projects can be added without
mixing them with the public UltrafuzzBench cohort.

These labels are scoring inputs. Workers must keep them outside agent-visible
target checkouts and published public artifacts.
