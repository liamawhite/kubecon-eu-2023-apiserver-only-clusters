import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as k8s from '@pulumi/kubernetes'
import { local } from '@pulumi/command'
import { VmService } from './vm'
import { networking } from './istio'

export const pulumiFunction = async () => {
    const region = 'us-central1'
    const kubeconfigFile = `${__dirname}/kubeconfig`
    const istio = {
        version: '1.17.2',
        repo: 'https://istio-release.storage.googleapis.com/charts',
    }
    const cluster = {
        name: 'controlplane',
        network: 'kube-network',
    }
    const vmNetwork = 'vm-network'

    const project = new gcp.organizations.Project('project', {
        orgId: '775566979306',
        projectId: 'kubecon-eu-2023-apiserver',
        billingAccount: '0183E5-447B34-776DEB',
        labels: {
            tetrate_owner: 'liam',
            tetrate_team: 'devrel',
        },
    }).projectId

    const containerService = new gcp.projects.Service('gke', {
        project,
        service: 'container.googleapis.com',
    })

    const network = new gcp.compute.Network('network', {
        project,
        autoCreateSubnetworks: false,
    })

    // Create a subnet on the network.
    const subnet = new gcp.compute.Subnetwork('subnet', {
        project,
        region,
        ipCidrRange: '10.0.1.0/24',
        network: network.id,
    })

    const gke = new gcp.container.Cluster(
        'cluster',
        {
            location: region,
            enableAutopilot: true,
            project,
            ipAllocationPolicy: {},
        },
        { dependsOn: containerService },
    )

    const context = pulumi.interpolate`${project}_${gke.name}`
    const kubeconfig = {
        apiVersion: 'v1',
        clusters: [
            {
                name: context,
                cluster: {
                    'certificate-authority-data': gke.masterAuth.clusterCaCertificate,
                    server: pulumi.interpolate`https://${gke.endpoint}`,
                },
            },
        ],
        contexts: [
            {
                name: context,
                context: {
                    cluster: context,
                    user: context,
                },
            },
        ],
        'current-context': context,
        kind: 'Config',
        preferences: {},
        users: [
            {
                name: context,
                user: {
                    exec: {
                        apiVersion: 'client.authentication.k8s.io/v1beta1',
                        command: 'gke-gcloud-auth-plugin',
                        installHint:
                            'Install gke-gcloud-auth-plugin for use with kubectl by following https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke',
                        provideClusterInfo: true,
                    },
                },
            },
        ],
    }

    const localKc = new local.Command(
        'kc',
        {
            triggers: [{ always: new Date().getMilliseconds() }],
            create: pulumi.interpolate`echo $KUBECONFIG > ${kubeconfigFile}`,
            environment: { KUBECONFIG: pulumi.output(kubeconfig).apply(JSON.stringify) },
        },
        { deleteBeforeReplace: true },
    )

    const k8sProvider = new k8s.Provider('k8s', {
        kubeconfig: pulumi.output(kubeconfig).apply(JSON.stringify),
    })
    const clusterOpts: pulumi.ResourceOptions = {
        provider: k8sProvider,
        parent: gke,
        dependsOn: localKc,
    }

    const istioNamespace = new k8s.core.v1.Namespace(
        'istio-system',
        { metadata: { name: 'istio-system' } },
        clusterOpts,
    )

    const base = new k8s.helm.v3.Chart(
        'istio-base',
        {
            chart: 'base',
            version: istio.version,
            namespace: istioNamespace.metadata.name,
            fetchOpts: {
                repo: istio.repo,
            },
        },
        clusterOpts,
    )

    new k8s.helm.v3.Chart(
        'istio-istiod',
        {
            chart: 'istiod',
            version: istio.version,
            namespace: istioNamespace.metadata.name,
            fetchOpts: {
                repo: istio.repo,
            },
            values: {
                global: {
                    meshID: 'mesh',
                    multiCluster: {
                        clusterName: 'controlplane',
                    },
                },
            },
        },
        { ...clusterOpts, dependsOn: base },
    )

    const ewgw = new k8s.helm.v3.Chart(
        'istio-eastwestgateway',
        {
            chart: 'gateway',
            version: istio.version,
            namespace: istioNamespace.metadata.name,
            fetchOpts: {
                repo: istio.repo,
            },
            values: {
                // global: {
                //     network: cluster.network,
                // },
                labels: {
                    istio: 'eastwestgateway',
                    app: 'istio-eastwestgateway',
                    'topology.istio.io/network': cluster.network,
                },
                service: {
                    ports: [
                        {
                            name: 'status-port',
                            port: 15021,
                            targetPort: 15021,
                        },
                        {
                            name: 'tls',
                            port: 15443,
                            targetPort: 15443,
                        },
                        {
                            name: 'tls-istiod',
                            port: 15012,
                            targetPort: 15012,
                        },
                        {
                            name: 'tls-webhook',
                            port: 15017,
                            targetPort: 15017,
                        },
                    ],
                },
            },
        },
        { ...clusterOpts, dependsOn: base },
    )

    // https://raw.githubusercontent.com/istio/istio/release-1.17/samples/multicluster/expose-istiod.yaml
    const istiodgw = new networking.v1alpha3.Gateway(
        'istiod-gateway',
        {
            metadata: { namespace: 'istio-system' },
            spec: {
                selector: {
                    istio: 'eastwestgateway',
                },
                servers: [
                    {
                        port: {
                            name: 'tls-istiod',
                            number: 15012,
                            protocol: 'tls',
                        },
                        tls: {
                            mode: 'PASSTHROUGH',
                        },
                        hosts: ['*'],
                    },
                    {
                        port: {
                            name: 'tls-istiodwebhook',
                            number: 15017,
                            protocol: 'tls',
                        },
                        tls: {
                            mode: 'PASSTHROUGH',
                        },
                        hosts: ['*'],
                    },
                ],
            },
        },
        clusterOpts,
    )

    new networking.v1alpha3.VirtualService(
        'istiod-vs',
        {
            metadata: { namespace: 'istio-system' },
            spec: {
                hosts: ['*'],
                gateways: [pulumi.output(istiodgw.metadata.apply((m) => m?.name || ''))],
                tls: [
                    {
                        match: [
                            {
                                port: 15012,
                                sniHosts: ['*'],
                            },
                        ],
                        route: [
                            {
                                destination: {
                                    host: 'istiod.istio-system.svc.cluster.local',
                                    port: {
                                        number: 15012,
                                    },
                                },
                            },
                        ],
                    },
                    {
                        match: [
                            {
                                port: 15017,
                                sniHosts: ['*'],
                            },
                        ],
                        route: [
                            {
                                destination: {
                                    host: 'istiod.istio-system.svc.cluster.local',
                                    port: {
                                        number: 443,
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        },
        clusterOpts,
    )

    new networking.v1alpha3.Gateway(
        'cross-network-gateway',
        {
            metadata: { namespace: 'istio-system' },
            spec: {
                selector: {
                    istio: 'eastwestgateway',
                },
                servers: [
                    {
                        port: {
                            number: 15443,
                            name: 'tls',
                            protocol: 'TLS',
                        },
                        tls: {
                            mode: 'AUTO_PASSTHROUGH',
                        },
                        hosts: ['*.local'],
                    },
                ],
            },
        },
        clusterOpts,
    )

    const firewall = new gcp.compute.Firewall('firewall', {
        project,
        network: network.selfLink,
        allows: [
            {
                protocol: 'tcp',
                ports: ['22', '80'],
            },
        ],
        direction: 'INGRESS',
        sourceRanges: ['0.0.0.0/0'],
        targetTags: [],
    })

    const onpremns = new k8s.core.v1.Namespace(
        'on-prem',
        { metadata: { name: 'onprem' } },
        clusterOpts,
    )

    new VmService(
        'test',
        {
            project,
            network,
            subnetId: subnet.id,
            zone: `${region}-b`,
            namespace: onpremns.metadata.name,
            kubeconfigFile,
            istioVersion: istio.version,
            cluster,
            vmNetwork,
        },
        { dependsOn: pulumi.all([ewgw.ready]).apply(([rs]) => [...rs, firewall]), clusterOpts },
    )
}
