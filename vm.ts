import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { local, remote, types } from '@pulumi/command'
import * as tls from '@pulumi/tls'
import * as k8s from '@pulumi/kubernetes'
import { networking } from './istio'

interface VmServiceArgs {
    network: {
        name: pulumi.Input<string>
        id: pulumi.Input<string>
    }
    subnetId: pulumi.Input<string>
    project: pulumi.Input<string>
    zone: pulumi.Input<string>
    kubeconfigFile: pulumi.Input<string>
    istioVersion: pulumi.Input<string>
    cluster: {
        name: pulumi.Input<string>,
        network: pulumi.Input<string>,
    }
    vmNetwork: pulumi.Input<string>,
    
    namespace: pulumi.Input<string>
}

export class VmService extends pulumi.ComponentResource {
    privateKey: pulumi.Input<string>
    
    hostname: pulumi.Input<string>

    constructor(name: string, args: VmServiceArgs, opts: pulumi.ComponentResourceOptions & { clusterOpts: pulumi.ResourceOptions }) {
        super("gcp:istio:vmservice", name)

        const WORK_DIR = `${__dirname}/workloads/${name}` 
        const envs: pulumi.Input<{
            [key: string]: pulumi.Input<string>;
        }> = {
            KUBECONFIG: args.kubeconfigFile,
            VM_APP: name,
            VM_NAMESPACE: args.namespace,
            WORK_DIR,
            SERVICE_ACCOUNT: name,
            CLUSTER_NETWORK: args.cluster.network,
            VM_NETWORK: args.vmNetwork,
            CLUSTER: args.cluster.name,
        }

        const sa = new k8s.core.v1.ServiceAccount(name, {
            metadata: { name, namespace: args.namespace }
        }, {...opts.clusterOpts, deleteBeforeReplace: true })

        new networking.v1alpha3.WorkloadGroup(name, {
            metadata: {
                name: envs.VM_APP,
                namespace: envs.VM_NAMESPACE,
            },
            spec: {
                metadata: {labels: { app: envs.VM_APP }},
                template: {
                    serviceAccount: envs.SERVICE_ACCOUNT,
                    network: envs.VM_NETWORK,
                }
            }
        }, opts.clusterOpts)

        const workDir = new local.Command(name, {
            environment: envs,
            delete: `rm -rf "\${WORK_DIR}"`,
            create: `
mkdir -p "\${WORK_DIR}"

cd "\${WORK_DIR}"

cat <<EOF > workloadgroup.yaml
apiVersion: networking.istio.io/v1alpha3
kind: WorkloadGroup
metadata:
  name: "\${VM_APP}"
  namespace: "\${VM_NAMESPACE}"
spec:
  metadata:
    labels:
      app: "\${VM_APP}"
  template:
    serviceAccount: "\${SERVICE_ACCOUNT}"
    network: "\${VM_NETWORK}"
EOF

istioctl x workload entry configure -f workloadgroup.yaml -o "\${WORK_DIR}" --clusterID "\${CLUSTER}"  --autoregister
`,

        }, { dependsOn: sa, deleteBeforeReplace: true })

        const sshKey = new tls.PrivateKey(name, {algorithm: 'ED25519'})
        this.privateKey = sshKey.privateKeyOpenssh

        const vm = new gcp.compute.Instance(name, {
            project: args.project,
            zone: args.zone,
            machineType: 'f1-micro', // g1-small e2-micro e2-small
            bootDisk: {
                initializeParams: {
                    image: 'ubuntu-2204-jammy-v20230302',
                },
            },
            networkInterfaces: [
                {
                    network: args.network.id,
                    subnetwork: args.subnetId,
                    accessConfigs: [
                        {},
                    ],
                },
            ],
            serviceAccount: {
                scopes: [
                    "https://www.googleapis.com/auth/cloud-platform",
                ],
            },
            allowStoppingForUpdate: true,
            metadata: {
                'ssh-keys': pulumi.interpolate`istio:${sshKey.publicKeyOpenssh} istio`,
            }
        }, opts)

        this.hostname = pulumi.output(vm.networkInterfaces[0]).apply((netint) => netint.accessConfigs ? netint.accessConfigs[0].natIp : '')

        // Write hostname and private key to disk for debugging
        const keyOnDisk = new local.Command(`${name}-key`, {
            environment: {
                SSHKEY: this.privateKey,
                HOSTNAME: this.hostname,
            },
            create: `
echo "$SSHKEY" > ${WORK_DIR}/key
chmod 0600 ${WORK_DIR}/key
echo "$HOSTNAME" > ${WORK_DIR}/hostname            
`,
            delete: `rm -f ${WORK_DIR}/key ${WORK_DIR}/hostname`,
        }, { deleteBeforeReplace: true })

        const connection: types.input.remote.ConnectionArgs = {
            host: this.hostname,
            user: "istio",
            privateKey: sshKey.privateKeyOpenssh,
        }

        // Configure the VM
        // https://istio.io/latest/docs/setup/install/virtual-machine/#configure-the-virtual-machine
        const files = ["cluster.env", "istio-token", "mesh.yaml", "root-cert.pem", "hosts"]
        const remoteFiles = files.map((f) => new remote.CopyFile(`${name}-${f}`, {
            connection,
            localPath: `${WORK_DIR}/${f}`,
            remotePath: `/home/istio/${f}`,
        }, { dependsOn: [vm, workDir], deleteBeforeReplace: true }))


        const dockerSetup = new remote.Command(`${name}-docker-setup`, {
            connection,
            create: `
sudo apt-get -y update
sudo apt-get -y --no-install-recommends install \
    ca-certificates \
    curl \
    gnupg

sudo mkdir -m 0755 -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get -y update
sudo apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker istio`
        })

        // Tried remote docker daemon via ssh and couldn't get it to work 🤷
        const dockerRun = new remote.Command(`${name}-docker-run`, {
            connection,
            create: `docker run -d --name ${name} -e WHERE=vm --network host -p 80:80 ghcr.io/chinaran/go-httpbin:1.4-alpine3.17`,
            delete: `docker rm -f ${name}`,
        }, { dependsOn: dockerSetup, deleteBeforeReplace: true })

        new remote.Command(`${name}-configure`, {
            connection,
            create: `
sudo mkdir -p /etc/certs
sudo cp /home/istio/root-cert.pem /etc/certs/root-cert.pem

sudo  mkdir -p /var/run/secrets/tokens
sudo cp /home/istio/istio-token /var/run/secrets/tokens/istio-token

curl -LO https://storage.googleapis.com/istio-release/releases/${args.istioVersion}/deb/istio-sidecar.deb
sudo dpkg -i istio-sidecar.deb

sudo cp /home/istio/cluster.env /var/lib/istio/envoy/cluster.env

sudo cp /home/istio/mesh.yaml /etc/istio/config/mesh

sudo sh -c 'cat $(eval echo ~$SUDO_USER)/hosts >> /etc/hosts'

sudo mkdir -p /etc/istio/proxy
sudo chown -R istio-proxy /var/lib/istio /etc/certs /etc/istio/proxy /etc/istio/config /var/run/secrets /etc/certs/root-cert.pem

sudo systemctl start istio
`,
        }, { dependsOn: [...remoteFiles, dockerRun] })

    }
}