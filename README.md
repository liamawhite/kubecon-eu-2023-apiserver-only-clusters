# "Serverless" Istio as a Service

This is a very basic prototype demonstrating how to onboard a VM into a remote "Serverless" Istio as a service cluster.

Whilst functional, it's not recommended you actually run it. Instead it's meant to provide pointers for how to configure Istio and onboard VMs in this architecture.

The main two files you should go through are `function.ts` and `vm.ts`. `index.ts` contains the code for running/bootstrapping Pulumi.