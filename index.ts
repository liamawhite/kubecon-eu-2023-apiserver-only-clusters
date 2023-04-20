import { LocalWorkspace } from "@pulumi/pulumi/automation";
import { Command, Option } from "commander";
import { pulumiFunction } from "./function";

export const cli = new Command()
  .name("demo")
  .description("Provision the demo infra")
  .addOption(new Option("--destroy", "Tear down all the provisioned infra"))
  .action(async (opts: { destroy: boolean }) => {
    const stack = await LocalWorkspace.createOrSelectStack(
      {
        stackName: 'demo',
        projectName: 'demo',
        program: pulumiFunction,
      },
      {
        envVars: { PULUMI_CONFIG_PASSPHRASE: "nah" },
        projectSettings: {
          runtime: "nodejs",
          name: "demo",
          backend: { url: `file://${__dirname}` },
        },
      }
    );

    await stack.cancel();

    if (opts.destroy) {
      try {
        const destroyRes = await stack.destroy({ onOutput: console.info });
        console.log(
          `destroy summary: \n${JSON.stringify(
            destroyRes.summary.resourceChanges,
            null,
            4
          )}`
        );
      } catch (e) {
        throw e;
      }
      return;
    }

    await stack.refresh();
    const upRes = await stack.up({ onOutput: console.info });
    console.log(
      `update summary: \n${JSON.stringify(
        upRes.summary.resourceChanges,
        null,
        4
      )}`
    );
  });



cli.parse(process.argv);
