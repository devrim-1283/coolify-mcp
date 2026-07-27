// GENERATED FILE — DO NOT EDIT, run npm run codegen
// Source: scripts/coolify-openapi.json (Coolify 4.2.0)

/**
 * Dereferenced, pruned request-body schemas keyed by operation id.
 * Absent id means the operation takes no JSON body.
 */
export const SCHEMAS: Record<string, unknown> = {
  'create-public-application': {
    required: [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'git_repository',
      'git_branch',
      'build_pack',
    ],
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'The environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      git_repository: {
        type: 'string',
        description: 'The git repository URL.',
      },
      git_branch: {
        type: 'string',
        description: 'The git branch.',
      },
      build_pack: {
        type: 'string',
        enum: [
          'nixpacks',
          'railpack',
          'static',
          'dockerfile',
          'dockercompose',
        ],
        description: 'The build pack type.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      git_commit_sha: {
        type: 'string',
        description: 'The git commit SHA.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      is_static: {
        type: 'boolean',
        description: 'The flag to indicate if the application is static.',
      },
      is_spa: {
        type: 'boolean',
        description: 'The flag to indicate if the application is a single-page application (SPA). Only relevant when is_static is true.',
      },
      is_auto_deploy_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if auto-deploy is enabled on git push. Defaults to true.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      static_image: {
        type: 'string',
        enum: ['nginx:alpine'],
        description: 'The static image.',
      },
      install_command: {
        type: 'string',
        description: 'The install command.',
      },
      build_command: {
        type: 'string',
        description: 'The build command.',
      },
      start_command: {
        type: 'string',
        description: 'The start command.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      base_directory: {
        type: 'string',
        description: 'The base directory for all commands.',
      },
      publish_directory: {
        type: 'string',
        description: 'The publish directory.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      dockerfile: {
        type: 'string',
        description: 'The Dockerfile content.',
      },
      dockerfile_location: {
        type: 'string',
        description: 'The Dockerfile location in the repository.',
      },
      docker_compose_location: {
        type: 'string',
        description: 'The Docker Compose location.',
      },
      docker_compose_custom_start_command: {
        type: 'string',
        description: 'The Docker Compose custom start command.',
      },
      docker_compose_custom_build_command: {
        type: 'string',
        description: 'The Docker Compose custom build command.',
      },
      docker_compose_domains: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a dockercompose application.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            domain: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io")',
            },
          },
          type: 'object',
        },
      },
      watch_paths: {
        type: 'string',
        description: 'The watch paths.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        default: false,
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      is_http_basic_auth_enabled: {
        type: 'boolean',
        description: 'HTTP Basic Authentication enabled.',
      },
      http_basic_auth_username: {
        type: 'string',
        nullable: true,
        description: 'Username for HTTP Basic Authentication',
      },
      http_basic_auth_password: {
        type: 'string',
        nullable: true,
        description: 'Password for HTTP Basic Authentication',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      autogenerate_domain: {
        type: 'boolean',
        default: true,
        description: 'If true and domains is empty, auto-generate a domain using the server\'s wildcard domain or sslip.io fallback. Default: true.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the application.',
      },
      is_preserve_repository_enabled: {
        type: 'boolean',
        default: false,
        description: 'Preserve repository during deployment.',
      },
    },
    type: 'object',
  },
  'create-private-github-app-application': {
    required: [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'github_app_uuid',
      'git_repository',
      'git_branch',
      'build_pack',
    ],
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'The environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      github_app_uuid: {
        type: 'string',
        description: 'The Github App UUID.',
      },
      git_repository: {
        type: 'string',
        description: 'The git repository URL.',
      },
      git_branch: {
        type: 'string',
        description: 'The git branch.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      build_pack: {
        type: 'string',
        enum: [
          'nixpacks',
          'railpack',
          'static',
          'dockerfile',
          'dockercompose',
        ],
        description: 'The build pack type.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      git_commit_sha: {
        type: 'string',
        description: 'The git commit SHA.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      is_static: {
        type: 'boolean',
        description: 'The flag to indicate if the application is static.',
      },
      is_spa: {
        type: 'boolean',
        description: 'The flag to indicate if the application is a single-page application (SPA). Only relevant when is_static is true.',
      },
      is_auto_deploy_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if auto-deploy is enabled on git push. Defaults to true.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      static_image: {
        type: 'string',
        enum: ['nginx:alpine'],
        description: 'The static image.',
      },
      install_command: {
        type: 'string',
        description: 'The install command.',
      },
      build_command: {
        type: 'string',
        description: 'The build command.',
      },
      start_command: {
        type: 'string',
        description: 'The start command.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      base_directory: {
        type: 'string',
        description: 'The base directory for all commands.',
      },
      publish_directory: {
        type: 'string',
        description: 'The publish directory.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      dockerfile: {
        type: 'string',
        description: 'The Dockerfile content.',
      },
      dockerfile_location: {
        type: 'string',
        description: 'The Dockerfile location in the repository',
      },
      docker_compose_location: {
        type: 'string',
        description: 'The Docker Compose location.',
      },
      docker_compose_custom_start_command: {
        type: 'string',
        description: 'The Docker Compose custom start command.',
      },
      docker_compose_custom_build_command: {
        type: 'string',
        description: 'The Docker Compose custom build command.',
      },
      docker_compose_domains: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a dockercompose application.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            domain: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io")',
            },
          },
          type: 'object',
        },
      },
      watch_paths: {
        type: 'string',
        description: 'The watch paths.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        default: false,
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      is_http_basic_auth_enabled: {
        type: 'boolean',
        description: 'HTTP Basic Authentication enabled.',
      },
      http_basic_auth_username: {
        type: 'string',
        nullable: true,
        description: 'Username for HTTP Basic Authentication',
      },
      http_basic_auth_password: {
        type: 'string',
        nullable: true,
        description: 'Password for HTTP Basic Authentication',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      autogenerate_domain: {
        type: 'boolean',
        default: true,
        description: 'If true and domains is empty, auto-generate a domain using the server\'s wildcard domain or sslip.io fallback. Default: true.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the application.',
      },
      is_preserve_repository_enabled: {
        type: 'boolean',
        default: false,
        description: 'Preserve repository during deployment.',
      },
    },
    type: 'object',
  },
  'create-private-deploy-key-application': {
    required: [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'private_key_uuid',
      'git_repository',
      'git_branch',
      'build_pack',
    ],
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'The environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      private_key_uuid: {
        type: 'string',
        description: 'The private key UUID.',
      },
      git_repository: {
        type: 'string',
        description: 'The git repository URL.',
      },
      git_branch: {
        type: 'string',
        description: 'The git branch.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      build_pack: {
        type: 'string',
        enum: [
          'nixpacks',
          'railpack',
          'static',
          'dockerfile',
          'dockercompose',
        ],
        description: 'The build pack type.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      git_commit_sha: {
        type: 'string',
        description: 'The git commit SHA.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      is_static: {
        type: 'boolean',
        description: 'The flag to indicate if the application is static.',
      },
      is_spa: {
        type: 'boolean',
        description: 'The flag to indicate if the application is a single-page application (SPA). Only relevant when is_static is true.',
      },
      is_auto_deploy_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if auto-deploy is enabled on git push. Defaults to true.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      static_image: {
        type: 'string',
        enum: ['nginx:alpine'],
        description: 'The static image.',
      },
      install_command: {
        type: 'string',
        description: 'The install command.',
      },
      build_command: {
        type: 'string',
        description: 'The build command.',
      },
      start_command: {
        type: 'string',
        description: 'The start command.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      base_directory: {
        type: 'string',
        description: 'The base directory for all commands.',
      },
      publish_directory: {
        type: 'string',
        description: 'The publish directory.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      dockerfile: {
        type: 'string',
        description: 'The Dockerfile content.',
      },
      dockerfile_location: {
        type: 'string',
        description: 'The Dockerfile location in the repository.',
      },
      docker_compose_location: {
        type: 'string',
        description: 'The Docker Compose location.',
      },
      docker_compose_custom_start_command: {
        type: 'string',
        description: 'The Docker Compose custom start command.',
      },
      docker_compose_custom_build_command: {
        type: 'string',
        description: 'The Docker Compose custom build command.',
      },
      docker_compose_domains: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a dockercompose application.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            domain: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io")',
            },
          },
          type: 'object',
        },
      },
      watch_paths: {
        type: 'string',
        description: 'The watch paths.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        default: false,
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      is_http_basic_auth_enabled: {
        type: 'boolean',
        description: 'HTTP Basic Authentication enabled.',
      },
      http_basic_auth_username: {
        type: 'string',
        nullable: true,
        description: 'Username for HTTP Basic Authentication',
      },
      http_basic_auth_password: {
        type: 'string',
        nullable: true,
        description: 'Password for HTTP Basic Authentication',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      autogenerate_domain: {
        type: 'boolean',
        default: true,
        description: 'If true and domains is empty, auto-generate a domain using the server\'s wildcard domain or sslip.io fallback. Default: true.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the application.',
      },
      is_preserve_repository_enabled: {
        type: 'boolean',
        default: false,
        description: 'Preserve repository during deployment.',
      },
    },
    type: 'object',
  },
  'create-dockerfile-application': {
    required: [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'dockerfile',
    ],
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'The environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      dockerfile: {
        type: 'string',
        description: 'The Dockerfile content.',
      },
      build_pack: {
        type: 'string',
        enum: ['dockerfile'],
        description: 'The build pack type.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      base_directory: {
        type: 'string',
        description: 'The base directory for all commands.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        default: false,
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      is_http_basic_auth_enabled: {
        type: 'boolean',
        description: 'HTTP Basic Authentication enabled.',
      },
      http_basic_auth_username: {
        type: 'string',
        nullable: true,
        description: 'Username for HTTP Basic Authentication',
      },
      http_basic_auth_password: {
        type: 'string',
        nullable: true,
        description: 'Password for HTTP Basic Authentication',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      autogenerate_domain: {
        type: 'boolean',
        default: true,
        description: 'If true and domains is empty, auto-generate a domain using the server\'s wildcard domain or sslip.io fallback. Default: true.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the application.',
      },
    },
    type: 'object',
  },
  'create-dockerimage-application': {
    required: [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'docker_registry_image_name',
    ],
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'The environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        default: false,
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      is_http_basic_auth_enabled: {
        type: 'boolean',
        description: 'HTTP Basic Authentication enabled.',
      },
      http_basic_auth_username: {
        type: 'string',
        nullable: true,
        description: 'Username for HTTP Basic Authentication',
      },
      http_basic_auth_password: {
        type: 'string',
        nullable: true,
        description: 'Password for HTTP Basic Authentication',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      autogenerate_domain: {
        type: 'boolean',
        default: true,
        description: 'If true and domains is empty, auto-generate a domain using the server\'s wildcard domain or sslip.io fallback. Default: true.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the application.',
      },
    },
    type: 'object',
  },
  'update-application-by-uuid': {
    properties: {
      project_uuid: {
        type: 'string',
        description: 'The project UUID.',
      },
      server_uuid: {
        type: 'string',
        description: 'The server UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'The environment name.',
      },
      github_app_uuid: {
        type: 'string',
        description: 'The Github App UUID.',
      },
      git_repository: {
        type: 'string',
        description: 'The git repository URL.',
      },
      git_branch: {
        type: 'string',
        description: 'The git branch.',
      },
      ports_exposes: {
        type: 'string',
        description: 'The ports to expose.',
      },
      destination_uuid: {
        type: 'string',
        description: 'The destination UUID.',
      },
      build_pack: {
        type: 'string',
        enum: [
          'nixpacks',
          'railpack',
          'static',
          'dockerfile',
          'dockercompose',
        ],
        description: 'The build pack type.',
      },
      name: {
        type: 'string',
        description: 'The application name.',
      },
      description: {
        type: 'string',
        description: 'The application description.',
      },
      domains: {
        type: 'string',
        description: 'The application URLs in a comma-separated list.',
      },
      git_commit_sha: {
        type: 'string',
        description: 'The git commit SHA.',
      },
      docker_registry_image_name: {
        type: 'string',
        description: 'The docker registry image name.',
      },
      docker_registry_image_tag: {
        type: 'string',
        description: 'The docker registry image tag.',
      },
      is_static: {
        type: 'boolean',
        description: 'The flag to indicate if the application is static.',
      },
      is_spa: {
        type: 'boolean',
        description: 'The flag to indicate if the application is a single-page application (SPA). Only relevant when is_static is true.',
      },
      is_auto_deploy_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if auto-deploy is enabled on git push. Defaults to true.',
      },
      is_force_https_enabled: {
        type: 'boolean',
        description: 'The flag to indicate if HTTPS is forced. Defaults to true.',
      },
      is_preview_deployments_enabled: {
        type: 'boolean',
        description: 'Enable preview deployments for pull requests.',
      },
      install_command: {
        type: 'string',
        description: 'The install command.',
      },
      build_command: {
        type: 'string',
        description: 'The build command.',
      },
      start_command: {
        type: 'string',
        description: 'The start command.',
      },
      ports_mappings: {
        type: 'string',
        description: 'The ports mappings.',
      },
      base_directory: {
        type: 'string',
        description: 'The base directory for all commands.',
      },
      publish_directory: {
        type: 'string',
        description: 'The publish directory.',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Health check enabled.',
      },
      health_check_path: {
        type: 'string',
        description: 'Health check path.',
      },
      health_check_port: {
        type: 'string',
        nullable: true,
        description: 'Health check port.',
      },
      health_check_host: {
        type: 'string',
        nullable: true,
        description: 'Health check host.',
      },
      health_check_method: {
        type: 'string',
        description: 'Health check method.',
      },
      health_check_return_code: {
        type: 'integer',
        description: 'Health check return code.',
      },
      health_check_scheme: {
        type: 'string',
        description: 'Health check scheme.',
      },
      health_check_response_text: {
        type: 'string',
        nullable: true,
        description: 'Health check response text.',
      },
      health_check_interval: {
        type: 'integer',
        description: 'Health check interval in seconds.',
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Health check timeout in seconds.',
      },
      health_check_retries: {
        type: 'integer',
        description: 'Health check retries count.',
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Health check start period in seconds.',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit.',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit.',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness.',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation.',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit.',
      },
      limits_cpuset: {
        type: 'string',
        nullable: true,
        description: 'CPU set.',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares.',
      },
      custom_labels: {
        type: 'string',
        description: 'Custom labels.',
      },
      custom_docker_run_options: {
        type: 'string',
        description: 'Custom docker run options.',
      },
      post_deployment_command: {
        type: 'string',
        description: 'Post deployment command.',
      },
      post_deployment_command_container: {
        type: 'string',
        description: 'Post deployment command container.',
      },
      pre_deployment_command: {
        type: 'string',
        description: 'Pre deployment command.',
      },
      pre_deployment_command_container: {
        type: 'string',
        description: 'Pre deployment command container.',
      },
      manual_webhook_secret_github: {
        type: 'string',
        description: 'Manual webhook secret for Github.',
      },
      manual_webhook_secret_gitlab: {
        type: 'string',
        description: 'Manual webhook secret for Gitlab.',
      },
      manual_webhook_secret_bitbucket: {
        type: 'string',
        description: 'Manual webhook secret for Bitbucket.',
      },
      manual_webhook_secret_gitea: {
        type: 'string',
        description: 'Manual webhook secret for Gitea.',
      },
      redirect: {
        type: 'string',
        nullable: true,
        description: 'How to set redirect with Traefik / Caddy. www<->non-www.',
        enum: ['www', 'non-www', 'both'],
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the application should be deployed instantly.',
      },
      dockerfile: {
        type: 'string',
        description: 'The Dockerfile content.',
      },
      dockerfile_location: {
        type: 'string',
        description: 'The Dockerfile location in the repository.',
      },
      docker_compose_location: {
        type: 'string',
        description: 'The Docker Compose location.',
      },
      docker_compose_custom_start_command: {
        type: 'string',
        description: 'The Docker Compose custom start command.',
      },
      docker_compose_custom_build_command: {
        type: 'string',
        description: 'The Docker Compose custom build command.',
      },
      docker_compose_domains: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a dockercompose application.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            domain: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io")',
            },
          },
          type: 'object',
        },
      },
      watch_paths: {
        type: 'string',
        description: 'The watch paths.',
      },
      use_build_server: {
        type: 'boolean',
        nullable: true,
        description: 'Use build server.',
      },
      use_build_secrets: {
        type: 'boolean',
        description: 'Use Docker Build Secrets for build-time environment variables.',
      },
      is_git_submodules_enabled: {
        type: 'boolean',
        description: 'Clone Git submodules.',
      },
      is_git_lfs_enabled: {
        type: 'boolean',
        description: 'Enable Git LFS.',
      },
      is_git_shallow_clone_enabled: {
        type: 'boolean',
        description: 'Use a shallow Git clone.',
      },
      disable_build_cache: {
        type: 'boolean',
        description: 'Disable the build cache.',
      },
      inject_build_args_to_dockerfile: {
        type: 'boolean',
        description: 'Inject build arguments into the Dockerfile build.',
      },
      include_source_commit_in_build: {
        type: 'boolean',
        description: 'Include the source commit in the build.',
      },
      is_env_sorting_enabled: {
        type: 'boolean',
        description: 'Sort environment variables.',
      },
      is_pr_deployments_public_enabled: {
        type: 'boolean',
        description: 'Make pull request deployments public.',
      },
      stop_grace_period: {
        type: 'integer',
        nullable: true,
        minimum: 1,
        maximum: 3600,
        description: 'Container stop grace period in seconds.',
      },
      docker_images_to_keep: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Number of Docker images to retain.',
      },
      is_gzip_enabled: {
        type: 'boolean',
        description: 'Enable gzip compression.',
      },
      is_stripprefix_enabled: {
        type: 'boolean',
        description: 'Enable path prefix stripping.',
      },
      is_raw_compose_deployment_enabled: {
        type: 'boolean',
        description: 'Deploy the raw Docker Compose definition.',
      },
      connect_to_docker_network: {
        type: 'boolean',
        description: 'The flag to connect the service to the predefined Docker network.',
      },
      force_domain_override: {
        type: 'boolean',
        description: 'Force domain usage even if conflicts are detected. Default is false.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
      },
      is_preserve_repository_enabled: {
        type: 'boolean',
      },
    },
    type: 'object',
  },
  'create-env-by-application-uuid': {
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_preview: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is used in preview deployments.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-env-by-application-uuid': {
    required: ['key', 'value'],
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_preview: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is used in preview deployments.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-envs-by-application-uuid': {
    required: ['data'],
    properties: {
      data: {
        type: 'array',
        items: {
          properties: {
            key: {
              type: 'string',
              description: 'The key of the environment variable.',
            },
            value: {
              type: 'string',
              description: 'The value of the environment variable.',
            },
            is_preview: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is used in preview deployments.',
            },
            is_literal: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
            },
            is_multiline: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is multiline.',
            },
            is_shown_once: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
            },
          },
          type: 'object',
        },
      },
    },
    type: 'object',
  },
  'move-application-by-uuid': {
    required: ['environment_uuid'],
    properties: {
      environment_uuid: {
        type: 'string',
        description: 'UUID of the target environment.',
      },
    },
    type: 'object',
  },
  'create-storage-by-application-uuid': {
    required: ['type', 'mount_path'],
    properties: {
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage.',
      },
      name: {
        type: 'string',
        description: 'Volume name (persistent only, required for persistent).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path.',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, optional).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'File content (file only, optional).',
      },
      is_directory: {
        type: 'boolean',
        description: 'Whether this is a directory mount (file only, default false).',
      },
      fs_path: {
        type: 'string',
        description: 'Host directory path (required when is_directory is true).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'update-storage-by-application-uuid': {
    required: ['type'],
    properties: {
      uuid: {
        type: 'string',
        description: 'The UUID of the storage (preferred).',
      },
      id: {
        type: 'integer',
        description: 'The ID of the storage (deprecated, use uuid instead).',
      },
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage: persistent or file.',
      },
      is_preview_suffix_enabled: {
        type: 'boolean',
        description: 'Whether to add -pr-N suffix for preview deployments.',
      },
      name: {
        type: 'string',
        description: 'The volume name (persistent only, not allowed for read-only storages).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path (not allowed for read-only storages).',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, not allowed for read-only storages).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'The file content (file only, not allowed for read-only storages).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'create-tag-by-application-uuid': {
    properties: {
      tag_name: {
        type: 'string',
        description: 'The tag name (min 2 characters). Required if tag_names is not provided.',
      },
      tag_names: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Array of tag names (each min 2 characters). Required if tag_name is not provided.',
      },
    },
    type: 'object',
  },
  'create-cloud-token': {
    required: ['provider', 'token', 'name'],
    properties: {
      provider: {
        type: 'string',
        enum: ['hetzner', 'digitalocean', 'vultr'],
        description: 'The cloud provider.',
      },
      token: {
        type: 'string',
        description: 'The API token for the cloud provider.',
      },
      name: {
        type: 'string',
        description: 'A friendly name for the token.',
      },
    },
    type: 'object',
  },
  'update-cloud-token-by-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The friendly name for the token.',
      },
    },
    type: 'object',
  },
  'create-database-backup': {
    required: ['frequency'],
    properties: {
      frequency: {
        type: 'string',
        description: 'Backup frequency (cron expression or: every_minute, hourly, daily, weekly, monthly, yearly)',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the backup is enabled',
        default: true,
      },
      save_s3: {
        type: 'boolean',
        description: 'Whether to save backups to S3',
        default: false,
      },
      s3_storage_uuid: {
        type: 'string',
        description: 'S3 storage UUID (required if save_s3 is true)',
      },
      databases_to_backup: {
        type: 'string',
        description: 'Comma separated list of databases to backup',
      },
      dump_all: {
        type: 'boolean',
        description: 'Whether to dump all databases',
        default: false,
      },
      backup_now: {
        type: 'boolean',
        description: 'Whether to trigger backup immediately after creation',
      },
      database_backup_retention_amount_locally: {
        type: 'integer',
        description: 'Number of backups to retain locally',
      },
      database_backup_retention_days_locally: {
        type: 'integer',
        description: 'Number of days to retain backups locally',
      },
      database_backup_retention_max_storage_locally: {
        type: 'number',
        description: 'Max storage (GB) for local backups',
      },
      database_backup_retention_amount_s3: {
        type: 'integer',
        description: 'Number of backups to retain in S3',
      },
      database_backup_retention_days_s3: {
        type: 'integer',
        description: 'Number of days to retain backups in S3',
      },
      database_backup_retention_max_storage_s3: {
        type: 'number',
        description: 'Max storage (GB) for S3 backups',
      },
      timeout: {
        type: 'integer',
        description: 'Backup job timeout in seconds (min: 60, max: 36000)',
        default: 3600,
      },
    },
    type: 'object',
  },
  'update-database-by-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      postgres_user: {
        type: 'string',
        description: 'PostgreSQL user',
      },
      postgres_password: {
        type: 'string',
        description: 'PostgreSQL password',
      },
      postgres_db: {
        type: 'string',
        description: 'PostgreSQL database',
      },
      postgres_initdb_args: {
        type: 'string',
        description: 'PostgreSQL initdb args',
      },
      postgres_host_auth_method: {
        type: 'string',
        description: 'PostgreSQL host auth method',
      },
      postgres_conf: {
        type: 'string',
        description: 'PostgreSQL conf',
      },
      clickhouse_admin_user: {
        type: 'string',
        description: 'Clickhouse admin user',
      },
      clickhouse_admin_password: {
        type: 'string',
        description: 'Clickhouse admin password',
      },
      dragonfly_password: {
        type: 'string',
        description: 'DragonFly password',
      },
      redis_password: {
        type: 'string',
        description: 'Redis password',
      },
      redis_conf: {
        type: 'string',
        description: 'Redis conf',
      },
      keydb_password: {
        type: 'string',
        description: 'KeyDB password',
      },
      keydb_conf: {
        type: 'string',
        description: 'KeyDB conf',
      },
      mariadb_conf: {
        type: 'string',
        description: 'MariaDB conf',
      },
      mariadb_root_password: {
        type: 'string',
        description: 'MariaDB root password',
      },
      mariadb_user: {
        type: 'string',
        description: 'MariaDB user',
      },
      mariadb_password: {
        type: 'string',
        description: 'MariaDB password',
      },
      mariadb_database: {
        type: 'string',
        description: 'MariaDB database',
      },
      mongo_conf: {
        type: 'string',
        description: 'Mongo conf',
      },
      mongo_initdb_root_username: {
        type: 'string',
        description: 'Mongo initdb root username',
      },
      mongo_initdb_root_password: {
        type: 'string',
        description: 'Mongo initdb root password',
      },
      mongo_initdb_database: {
        type: 'string',
        description: 'Mongo initdb init database',
      },
      mysql_root_password: {
        type: 'string',
        description: 'MySQL root password',
      },
      mysql_password: {
        type: 'string',
        description: 'MySQL password',
      },
      mysql_user: {
        type: 'string',
        description: 'MySQL user',
      },
      mysql_database: {
        type: 'string',
        description: 'MySQL database',
      },
      mysql_conf: {
        type: 'string',
        description: 'MySQL conf',
      },
      health_check_enabled: {
        type: 'boolean',
        description: 'Enable the database healthcheck probe.',
        default: true,
      },
      health_check_interval: {
        type: 'integer',
        description: 'Healthcheck interval in seconds.',
        minimum: 1,
        default: 15,
      },
      health_check_timeout: {
        type: 'integer',
        description: 'Healthcheck timeout in seconds.',
        minimum: 1,
        default: 5,
      },
      health_check_retries: {
        type: 'integer',
        description: 'Healthcheck retries count.',
        minimum: 1,
        default: 5,
      },
      health_check_start_period: {
        type: 'integer',
        description: 'Healthcheck start period in seconds.',
        minimum: 0,
        default: 5,
      },
    },
    type: 'object',
  },
  'update-database-backup': {
    properties: {
      save_s3: {
        type: 'boolean',
        description: 'Whether data is saved in s3 or not',
      },
      s3_storage_uuid: {
        type: 'string',
        description: 'S3 storage UUID',
      },
      backup_now: {
        type: 'boolean',
        description: 'Whether to take a backup now or not',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the backup is enabled or not',
      },
      databases_to_backup: {
        type: 'string',
        description: 'Comma separated list of databases to backup',
      },
      dump_all: {
        type: 'boolean',
        description: 'Whether all databases are dumped or not',
      },
      frequency: {
        type: 'string',
        description: 'Frequency of the backup',
      },
      database_backup_retention_amount_locally: {
        type: 'integer',
        description: 'Retention amount of the backup locally',
      },
      database_backup_retention_days_locally: {
        type: 'integer',
        description: 'Retention days of the backup locally',
      },
      database_backup_retention_max_storage_locally: {
        type: 'number',
        description: 'Max storage of the backup locally',
      },
      database_backup_retention_amount_s3: {
        type: 'integer',
        description: 'Retention amount of the backup in s3',
      },
      database_backup_retention_days_s3: {
        type: 'integer',
        description: 'Retention days of the backup in s3',
      },
      database_backup_retention_max_storage_s3: {
        type: 'number',
        description: 'Max storage of the backup in S3',
      },
      timeout: {
        type: 'integer',
        description: 'Backup job timeout in seconds (min: 60, max: 36000)',
        default: 3600,
      },
    },
    type: 'object',
  },
  'create-database-postgresql': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      postgres_user: {
        type: 'string',
        description: 'PostgreSQL user',
      },
      postgres_password: {
        type: 'string',
        description: 'PostgreSQL password',
      },
      postgres_db: {
        type: 'string',
        description: 'PostgreSQL database',
      },
      postgres_initdb_args: {
        type: 'string',
        description: 'PostgreSQL initdb args',
      },
      postgres_host_auth_method: {
        type: 'string',
        description: 'PostgreSQL host auth method',
      },
      postgres_conf: {
        type: 'string',
        description: 'PostgreSQL conf',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-clickhouse': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      clickhouse_admin_user: {
        type: 'string',
        description: 'Clickhouse admin user',
      },
      clickhouse_admin_password: {
        type: 'string',
        description: 'Clickhouse admin password',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-dragonfly': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      dragonfly_password: {
        type: 'string',
        description: 'DragonFly password',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-redis': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      redis_password: {
        type: 'string',
        description: 'Redis password',
      },
      redis_conf: {
        type: 'string',
        description: 'Redis conf',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-keydb': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      keydb_password: {
        type: 'string',
        description: 'KeyDB password',
      },
      keydb_conf: {
        type: 'string',
        description: 'KeyDB conf',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-mariadb': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      mariadb_conf: {
        type: 'string',
        description: 'MariaDB conf',
      },
      mariadb_root_password: {
        type: 'string',
        description: 'MariaDB root password',
      },
      mariadb_user: {
        type: 'string',
        description: 'MariaDB user',
      },
      mariadb_password: {
        type: 'string',
        description: 'MariaDB password',
      },
      mariadb_database: {
        type: 'string',
        description: 'MariaDB database',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-mysql': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      mysql_root_password: {
        type: 'string',
        description: 'MySQL root password',
      },
      mysql_password: {
        type: 'string',
        description: 'MySQL password',
      },
      mysql_user: {
        type: 'string',
        description: 'MySQL user',
      },
      mysql_database: {
        type: 'string',
        description: 'MySQL database',
      },
      mysql_conf: {
        type: 'string',
        description: 'MySQL conf',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'create-database-mongodb': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      server_uuid: {
        type: 'string',
        description: 'UUID of the server',
      },
      project_uuid: {
        type: 'string',
        description: 'UUID of the project',
      },
      environment_name: {
        type: 'string',
        description: 'Name of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'UUID of the environment. You need to provide at least one of environment_name or environment_uuid.',
      },
      destination_uuid: {
        type: 'string',
        description: 'UUID of the destination if the server has multiple destinations',
      },
      mongo_conf: {
        type: 'string',
        description: 'MongoDB conf',
      },
      mongo_initdb_root_username: {
        type: 'string',
        description: 'MongoDB initdb root username',
      },
      name: {
        type: 'string',
        description: 'Name of the database',
      },
      description: {
        type: 'string',
        description: 'Description of the database',
      },
      image: {
        type: 'string',
        description: 'Docker Image of the database',
      },
      is_public: {
        type: 'boolean',
        description: 'Is the database public?',
      },
      public_port: {
        type: 'integer',
        description: 'Public port of the database',
      },
      public_port_timeout: {
        type: 'integer',
        description: 'Public port timeout in seconds (default: 3600)',
      },
      limits_memory: {
        type: 'string',
        description: 'Memory limit of the database',
      },
      limits_memory_swap: {
        type: 'string',
        description: 'Memory swap limit of the database',
      },
      limits_memory_swappiness: {
        type: 'integer',
        description: 'Memory swappiness of the database',
      },
      limits_memory_reservation: {
        type: 'string',
        description: 'Memory reservation of the database',
      },
      limits_cpus: {
        type: 'string',
        description: 'CPU limit of the database',
      },
      limits_cpuset: {
        type: 'string',
        description: 'CPU set of the database',
      },
      limits_cpu_shares: {
        type: 'integer',
        description: 'CPU shares of the database',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'Instant deploy the database',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the database.',
      },
    },
    type: 'object',
  },
  'move-database-by-uuid': {
    required: ['environment_uuid'],
    properties: {
      environment_uuid: {
        type: 'string',
        description: 'UUID of the target environment.',
      },
    },
    type: 'object',
  },
  'create-env-by-database-uuid': {
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-env-by-database-uuid': {
    required: ['key', 'value'],
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-envs-by-database-uuid': {
    required: ['data'],
    properties: {
      data: {
        type: 'array',
        items: {
          properties: {
            key: {
              type: 'string',
              description: 'The key of the environment variable.',
            },
            value: {
              type: 'string',
              description: 'The value of the environment variable.',
            },
            is_literal: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
            },
            is_multiline: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is multiline.',
            },
            is_shown_once: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
            },
          },
          type: 'object',
        },
      },
    },
    type: 'object',
  },
  'create-storage-by-database-uuid': {
    required: ['type', 'mount_path'],
    properties: {
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage.',
      },
      name: {
        type: 'string',
        description: 'Volume name (persistent only, required for persistent).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path.',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, optional).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'File content (file only, optional).',
      },
      is_directory: {
        type: 'boolean',
        description: 'Whether this is a directory mount (file only, default false).',
      },
      fs_path: {
        type: 'string',
        description: 'Host directory path (required when is_directory is true).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'update-storage-by-database-uuid': {
    required: ['type'],
    properties: {
      uuid: {
        type: 'string',
        description: 'The UUID of the storage (preferred).',
      },
      id: {
        type: 'integer',
        description: 'The ID of the storage (deprecated, use uuid instead).',
      },
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage: persistent or file.',
      },
      is_preview_suffix_enabled: {
        type: 'boolean',
        description: 'Whether to add -pr-N suffix for preview deployments.',
      },
      name: {
        type: 'string',
        description: 'The volume name (persistent only, not allowed for read-only storages).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path (not allowed for read-only storages).',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, not allowed for read-only storages).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'The file content (file only, not allowed for read-only storages).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'create-tag-by-database-uuid': {
    properties: {
      tag_name: {
        type: 'string',
        description: 'The tag name (min 2 characters). Required if tag_names is not provided.',
      },
      tag_names: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Array of tag names (each min 2 characters). Required if tag_name is not provided.',
      },
    },
    type: 'object',
  },
  'create-server-destination': {
    required: ['network'],
    properties: {
      name: {
        type: 'string',
        maxLength: 255,
      },
      network: {
        type: 'string',
        maxLength: 255,
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
      },
      type: {
        type: 'string',
        enum: ['standalone', 'swarm'],
      },
    },
    type: 'object',
  },
  'create-github-app': {
    required: [
      'name',
      'html_url',
      'app_id',
      'installation_id',
      'client_id',
      'client_secret',
      'private_key_uuid',
    ],
    properties: {
      name: {
        type: 'string',
        description: 'Name of the GitHub app.',
      },
      organization: {
        type: 'string',
        nullable: true,
        description: 'Organization to associate the app with.',
      },
      api_url: {
        type: 'string',
        description: 'API URL for the GitHub app (e.g., https://api.github.com).',
      },
      html_url: {
        type: 'string',
        description: 'HTML URL for the GitHub app (e.g., https://github.com).',
      },
      custom_user: {
        type: 'string',
        description: 'Custom user for SSH access (default: git).',
      },
      custom_port: {
        type: 'integer',
        description: 'Custom port for SSH access (default: 22).',
      },
      app_id: {
        type: 'integer',
        description: 'GitHub App ID from GitHub.',
      },
      installation_id: {
        type: 'integer',
        description: 'GitHub Installation ID.',
      },
      client_id: {
        type: 'string',
        description: 'GitHub OAuth App Client ID.',
      },
      client_secret: {
        type: 'string',
        description: 'GitHub OAuth App Client Secret.',
      },
      webhook_secret: {
        type: 'string',
        description: 'Webhook secret for GitHub webhooks.',
      },
      private_key_uuid: {
        type: 'string',
        description: 'UUID of an existing private key for GitHub App authentication.',
      },
      is_system_wide: {
        type: 'boolean',
        description: 'Is this app system-wide (cloud only).',
      },
    },
    type: 'object',
  },
  updateGithubApp: {
    properties: {
      name: {
        type: 'string',
        description: 'GitHub App name',
      },
      organization: {
        type: 'string',
        nullable: true,
        description: 'GitHub organization',
      },
      api_url: {
        type: 'string',
        description: 'GitHub API URL',
      },
      html_url: {
        type: 'string',
        description: 'GitHub HTML URL',
      },
      custom_user: {
        type: 'string',
        description: 'Custom user for SSH',
      },
      custom_port: {
        type: 'integer',
        description: 'Custom port for SSH',
      },
      app_id: {
        type: 'integer',
        description: 'GitHub App ID',
      },
      installation_id: {
        type: 'integer',
        description: 'GitHub Installation ID',
      },
      client_id: {
        type: 'string',
        description: 'GitHub Client ID',
      },
      client_secret: {
        type: 'string',
        description: 'GitHub Client Secret',
      },
      webhook_secret: {
        type: 'string',
        description: 'GitHub Webhook Secret',
      },
      private_key_uuid: {
        type: 'string',
        description: 'Private key UUID',
      },
      is_system_wide: {
        type: 'boolean',
        description: 'Is system wide (non-cloud instances only)',
      },
    },
    type: 'object',
  },
  'create-hetzner-server': {
    required: ['location', 'server_type', 'image', 'private_key_uuid'],
    properties: {
      cloud_provider_token_uuid: {
        type: 'string',
        description: 'Cloud provider token UUID. Required if cloud_provider_token_id is not provided.',
      },
      cloud_provider_token_id: {
        type: 'string',
        description: 'Deprecated: Use cloud_provider_token_uuid instead. Cloud provider token UUID.',
        deprecated: true,
      },
      location: {
        type: 'string',
        description: 'Hetzner location name',
      },
      server_type: {
        type: 'string',
        description: 'Hetzner server type name',
      },
      image: {
        type: 'integer',
        description: 'Hetzner image ID',
      },
      name: {
        type: 'string',
        description: 'Server name (auto-generated if not provided)',
      },
      private_key_uuid: {
        type: 'string',
        description: 'Private key UUID',
      },
      enable_ipv4: {
        type: 'boolean',
        description: 'Enable IPv4 (default: true)',
      },
      enable_ipv6: {
        type: 'boolean',
        description: 'Enable IPv6 (default: true)',
      },
      enable_backups: {
        type: 'boolean',
        description: 'Enable Hetzner server backups after creation (adds 20% to the monthly server fee)',
      },
      hetzner_ssh_key_ids: {
        type: 'array',
        items: {
          type: 'integer',
        },
        description: 'Additional Hetzner SSH key IDs',
      },
      hetzner_firewall_ids: {
        type: 'array',
        items: {
          type: 'integer',
        },
        description: 'Existing Hetzner firewall IDs to apply during server creation',
      },
      hetzner_network_ids: {
        type: 'array',
        items: {
          type: 'integer',
        },
        description: 'Existing Hetzner network IDs to attach during server creation',
      },
      cloud_init_script: {
        type: 'string',
        description: 'Cloud-init YAML script (optional)',
      },
      instant_validate: {
        type: 'boolean',
        description: 'Validate server immediately after creation',
      },
    },
    type: 'object',
  },
  'create-project': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the project.',
      },
      description: {
        type: 'string',
        description: 'The description of the project.',
      },
    },
    type: 'object',
  },
  'update-project-by-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the project.',
      },
      description: {
        type: 'string',
        description: 'The description of the project.',
      },
    },
    type: 'object',
  },
  'create-environment': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the environment.',
      },
    },
    type: 'object',
  },
  'create-scheduled-task-by-application-uuid': {
    required: ['name', 'command', 'frequency'],
    properties: {
      name: {
        type: 'string',
        description: 'The name of the scheduled task.',
      },
      command: {
        type: 'string',
        description: 'The command to execute.',
      },
      frequency: {
        type: 'string',
        description: 'The frequency of the scheduled task.',
      },
      container: {
        type: 'string',
        nullable: true,
        description: 'The container where the command should be executed.',
      },
      timeout: {
        type: 'integer',
        description: 'The timeout of the scheduled task in seconds.',
        default: 300,
      },
      enabled: {
        type: 'boolean',
        description: 'The flag to indicate if the scheduled task is enabled.',
        default: true,
      },
    },
    type: 'object',
  },
  'update-scheduled-task-by-application-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the scheduled task.',
      },
      command: {
        type: 'string',
        description: 'The command to execute.',
      },
      frequency: {
        type: 'string',
        description: 'The frequency of the scheduled task.',
      },
      container: {
        type: 'string',
        nullable: true,
        description: 'The container where the command should be executed.',
      },
      timeout: {
        type: 'integer',
        description: 'The timeout of the scheduled task in seconds.',
        default: 300,
      },
      enabled: {
        type: 'boolean',
        description: 'The flag to indicate if the scheduled task is enabled.',
        default: true,
      },
    },
    type: 'object',
  },
  'create-scheduled-task-by-service-uuid': {
    required: ['name', 'command', 'frequency'],
    properties: {
      name: {
        type: 'string',
        description: 'The name of the scheduled task.',
      },
      command: {
        type: 'string',
        description: 'The command to execute.',
      },
      frequency: {
        type: 'string',
        description: 'The frequency of the scheduled task.',
      },
      container: {
        type: 'string',
        nullable: true,
        description: 'The container where the command should be executed.',
      },
      timeout: {
        type: 'integer',
        description: 'The timeout of the scheduled task in seconds.',
        default: 300,
      },
      enabled: {
        type: 'boolean',
        description: 'The flag to indicate if the scheduled task is enabled.',
        default: true,
      },
    },
    type: 'object',
  },
  'update-scheduled-task-by-service-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the scheduled task.',
      },
      command: {
        type: 'string',
        description: 'The command to execute.',
      },
      frequency: {
        type: 'string',
        description: 'The frequency of the scheduled task.',
      },
      container: {
        type: 'string',
        nullable: true,
        description: 'The container where the command should be executed.',
      },
      timeout: {
        type: 'integer',
        description: 'The timeout of the scheduled task in seconds.',
        default: 300,
      },
      enabled: {
        type: 'boolean',
        description: 'The flag to indicate if the scheduled task is enabled.',
        default: true,
      },
    },
    type: 'object',
  },
  'create-private-key': {
    required: ['private_key'],
    properties: {
      name: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      private_key: {
        type: 'string',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'update-private-key': {
    required: ['private_key'],
    properties: {
      name: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      private_key: {
        type: 'string',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'create-server': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the server.',
      },
      description: {
        type: 'string',
        description: 'The description of the server.',
      },
      ip: {
        type: 'string',
        description: 'The IP of the server.',
      },
      port: {
        type: 'integer',
        description: 'The port of the server.',
      },
      user: {
        type: 'string',
        description: 'The user of the server.',
      },
      private_key_uuid: {
        type: 'string',
        description: 'The UUID of the private key.',
      },
      is_build_server: {
        type: 'boolean',
        description: 'Is build server.',
      },
      instant_validate: {
        type: 'boolean',
        description: 'Instant validate.',
      },
      proxy_type: {
        type: 'string',
        enum: ['traefik', 'caddy', 'none'],
        description: 'The proxy type.',
      },
    },
    type: 'object',
  },
  'update-server-by-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The name of the server.',
      },
      description: {
        type: 'string',
        description: 'The description of the server.',
      },
      ip: {
        type: 'string',
        description: 'The IP of the server.',
      },
      port: {
        type: 'integer',
        description: 'The port of the server.',
      },
      user: {
        type: 'string',
        description: 'The user of the server.',
      },
      private_key_uuid: {
        type: 'string',
        description: 'The UUID of the private key.',
      },
      is_build_server: {
        type: 'boolean',
        description: 'Is build server.',
      },
      instant_validate: {
        type: 'boolean',
        description: 'Instant validate.',
      },
      proxy_type: {
        type: 'string',
        enum: ['traefik', 'caddy', 'none'],
        description: 'The proxy type.',
      },
      concurrent_builds: {
        type: 'integer',
        description: 'Number of concurrent builds.',
      },
      dynamic_timeout: {
        type: 'integer',
        description: 'Deployment timeout in seconds.',
      },
      deployment_queue_limit: {
        type: 'integer',
        description: 'Maximum number of queued deployments.',
      },
      server_disk_usage_notification_threshold: {
        type: 'integer',
        description: 'Server disk usage notification threshold (%).',
      },
      server_disk_usage_check_frequency: {
        type: 'string',
        description: 'Cron expression for disk usage check frequency.',
      },
      connection_timeout: {
        type: 'integer',
        description: 'SSH connection timeout in seconds (1-300). Default: 10.',
      },
    },
    type: 'object',
  },
  'validate-server-by-uuid': {
    properties: {
      install: {
        description: 'Install missing prerequisites and Docker. This can restart the Docker daemon.',
        type: 'boolean',
        default: false,
      },
    },
    type: 'object',
  },
  'patch-service-application-by-service-and-app-uuid': {
    properties: {
      url: {
        description: 'Comma-separated list of URLs (e.g. "http://app.example.com:8080,https://app2.example.com"). Stored as fqdn.',
        type: ['string', 'null'],
      },
      human_name: {
        type: ['string', 'null'],
      },
      description: {
        type: ['string', 'null'],
      },
      image: {
        type: ['string', 'null'],
      },
      exclude_from_status: {
        type: ['boolean', 'null'],
      },
      is_log_drain_enabled: {
        type: ['boolean', 'null'],
      },
      is_gzip_enabled: {
        type: ['boolean', 'null'],
      },
      is_stripprefix_enabled: {
        type: ['boolean', 'null'],
      },
    },
    type: 'object',
  },
  'patch-service-database-by-service-and-database-uuid': {
    properties: {
      human_name: {
        type: ['string', 'null'],
      },
      description: {
        type: ['string', 'null'],
      },
      image: {
        type: 'string',
      },
      exclude_from_status: {
        type: 'boolean',
      },
      is_log_drain_enabled: {
        type: 'boolean',
      },
      is_public: {
        type: 'boolean',
      },
      public_port: {
        type: ['integer', 'null'],
        maximum: 65535,
        minimum: 1,
      },
      public_port_timeout: {
        type: ['integer', 'null'],
        minimum: 1,
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'create-service': {
    required: [
      'server_uuid',
      'project_uuid',
      'environment_name',
      'environment_uuid',
    ],
    properties: {
      type: {
        description: 'The one-click service type (e.g. "actualbudget", "calibre-web", "gitea-with-mysql" ...)',
        type: 'string',
      },
      name: {
        type: 'string',
        maxLength: 255,
        description: 'Name of the service.',
      },
      description: {
        type: 'string',
        nullable: true,
        description: 'Description of the service.',
      },
      project_uuid: {
        type: 'string',
        description: 'Project UUID.',
      },
      environment_name: {
        type: 'string',
        description: 'Environment name. You need to provide at least one of environment_name or environment_uuid.',
      },
      environment_uuid: {
        type: 'string',
        description: 'Environment UUID. You need to provide at least one of environment_name or environment_uuid.',
      },
      server_uuid: {
        type: 'string',
        description: 'Server UUID.',
      },
      destination_uuid: {
        type: 'string',
        description: 'Destination UUID. Required if server has multiple destinations.',
      },
      instant_deploy: {
        type: 'boolean',
        default: false,
        description: 'Start the service immediately after creation.',
      },
      docker_compose_raw: {
        type: 'string',
        description: 'The base64 encoded Docker Compose content.',
      },
      urls: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a service.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            url: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io").',
            },
          },
          type: 'object',
        },
      },
      force_domain_override: {
        type: 'boolean',
        default: false,
        description: 'Force domain override even if conflicts are detected.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
        description: 'Escape special characters in labels. By default, $ (and other chars) is escaped. If you want to use env variables inside the labels, turn this off.',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Tags to assign to the service.',
      },
    },
    type: 'object',
  },
  'update-service-by-uuid': {
    properties: {
      name: {
        type: 'string',
        description: 'The service name.',
      },
      description: {
        type: 'string',
        description: 'The service description.',
      },
      instant_deploy: {
        type: 'boolean',
        description: 'The flag to indicate if the service should be deployed instantly.',
      },
      connect_to_docker_network: {
        type: 'boolean',
        default: false,
        description: 'Connect the service to the predefined docker network.',
      },
      docker_compose_raw: {
        type: 'string',
        description: 'The base64 encoded Docker Compose content.',
      },
      urls: {
        type: 'array',
        description: 'Array of URLs to be applied to containers of a service.',
        items: {
          properties: {
            name: {
              type: 'string',
              description: 'The service name as defined in docker-compose.',
            },
            url: {
              type: 'string',
              description: 'Comma-separated list of URLs (e.g. "https://app.coolify.io,https://app2.coolify.io").',
            },
          },
          type: 'object',
        },
      },
      force_domain_override: {
        type: 'boolean',
        default: false,
        description: 'Force domain override even if conflicts are detected.',
      },
      is_container_label_escape_enabled: {
        type: 'boolean',
        default: true,
        description: 'Escape special characters in labels. By default, $ (and other chars) is escaped. If you want to use env variables inside the labels, turn this off.',
      },
    },
    type: 'object',
  },
  'create-env-by-service-uuid': {
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_preview: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is used in preview deployments.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-env-by-service-uuid': {
    required: ['key', 'value'],
    properties: {
      key: {
        type: 'string',
        description: 'The key of the environment variable.',
      },
      value: {
        type: 'string',
        description: 'The value of the environment variable.',
      },
      is_preview: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is used in preview deployments.',
      },
      is_literal: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
      },
      is_multiline: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable is multiline.',
      },
      is_shown_once: {
        type: 'boolean',
        description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
      },
    },
    type: 'object',
  },
  'update-envs-by-service-uuid': {
    required: ['data'],
    properties: {
      data: {
        type: 'array',
        items: {
          properties: {
            key: {
              type: 'string',
              description: 'The key of the environment variable.',
            },
            value: {
              type: 'string',
              description: 'The value of the environment variable.',
            },
            is_preview: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is used in preview deployments.',
            },
            is_literal: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is a literal, nothing espaced.',
            },
            is_multiline: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable is multiline.',
            },
            is_shown_once: {
              type: 'boolean',
              description: 'The flag to indicate if the environment variable\'s value is shown on the UI.',
            },
          },
          type: 'object',
        },
      },
    },
    type: 'object',
  },
  'move-service-by-uuid': {
    required: ['environment_uuid'],
    properties: {
      environment_uuid: {
        type: 'string',
        description: 'UUID of the target environment.',
      },
    },
    type: 'object',
  },
  'create-storage-by-service-uuid': {
    required: ['type', 'mount_path', 'resource_uuid'],
    properties: {
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage.',
      },
      resource_uuid: {
        type: 'string',
        description: 'UUID of the service application or database sub-resource.',
      },
      name: {
        type: 'string',
        description: 'Volume name (persistent only, required for persistent).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path.',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, optional).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'File content (file only, optional).',
      },
      is_directory: {
        type: 'boolean',
        description: 'Whether this is a directory mount (file only, default false).',
      },
      fs_path: {
        type: 'string',
        description: 'Host directory path (required when is_directory is true).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'update-storage-by-service-uuid': {
    required: ['type'],
    properties: {
      uuid: {
        type: 'string',
        description: 'The UUID of the storage (preferred).',
      },
      id: {
        type: 'integer',
        description: 'The ID of the storage (deprecated, use uuid instead).',
      },
      type: {
        type: 'string',
        enum: ['persistent', 'file'],
        description: 'The type of storage: persistent or file.',
      },
      is_preview_suffix_enabled: {
        type: 'boolean',
        description: 'Whether to add -pr-N suffix for preview deployments.',
      },
      name: {
        type: 'string',
        description: 'The volume name (persistent only, not allowed for read-only storages).',
      },
      mount_path: {
        type: 'string',
        description: 'The container mount path (not allowed for read-only storages).',
      },
      host_path: {
        type: 'string',
        nullable: true,
        description: 'The host path (persistent only, not allowed for read-only storages).',
      },
      content: {
        type: 'string',
        nullable: true,
        description: 'The file content (file only, not allowed for read-only storages).',
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'create-tag-by-service-uuid': {
    properties: {
      tag_name: {
        type: 'string',
        description: 'The tag name (min 2 characters). Required if tag_names is not provided.',
      },
      tag_names: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Array of tag names (each min 2 characters). Required if tag_name is not provided.',
      },
    },
    type: 'object',
  },
  'set-application-storage-backup-schedule': {
    required: ['frequency'],
    properties: {
      frequency: {
        type: 'string',
        maxLength: 255,
      },
      enabled: {
        type: 'boolean',
        default: true,
      },
      save_s3: {
        type: 'boolean',
        default: false,
      },
      disable_local_backup: {
        type: 'boolean',
        default: false,
      },
      stop_during_backup: {
        type: 'boolean',
        default: false,
      },
      s3_storage_uuid: {
        type: ['string', 'null'],
      },
      retention_amount_locally: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_locally: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_locally: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      retention_amount_s3: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_s3: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_s3: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      timeout: {
        type: 'integer',
        default: 3600,
        maximum: 36000,
        minimum: 60,
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'set-database-storage-backup-schedule': {
    required: ['frequency'],
    properties: {
      frequency: {
        type: 'string',
        maxLength: 255,
      },
      enabled: {
        type: 'boolean',
        default: true,
      },
      save_s3: {
        type: 'boolean',
        default: false,
      },
      disable_local_backup: {
        type: 'boolean',
        default: false,
      },
      stop_during_backup: {
        type: 'boolean',
        default: false,
      },
      s3_storage_uuid: {
        type: ['string', 'null'],
      },
      retention_amount_locally: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_locally: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_locally: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      retention_amount_s3: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_s3: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_s3: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      timeout: {
        type: 'integer',
        default: 3600,
        maximum: 36000,
        minimum: 60,
      },
    },
    type: 'object',
    additionalProperties: false,
  },
  'set-service-storage-backup-schedule': {
    required: ['frequency'],
    properties: {
      frequency: {
        type: 'string',
        maxLength: 255,
      },
      enabled: {
        type: 'boolean',
        default: true,
      },
      save_s3: {
        type: 'boolean',
        default: false,
      },
      disable_local_backup: {
        type: 'boolean',
        default: false,
      },
      stop_during_backup: {
        type: 'boolean',
        default: false,
      },
      s3_storage_uuid: {
        type: ['string', 'null'],
      },
      retention_amount_locally: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_locally: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_locally: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      retention_amount_s3: {
        type: 'integer',
        default: 7,
        maximum: 10000,
        minimum: 0,
      },
      retention_days_s3: {
        type: 'integer',
        default: 0,
        maximum: 2147483647,
        minimum: 0,
      },
      retention_max_storage_s3: {
        type: 'number',
        format: 'float',
        default: 0,
        maximum: 9999999999,
        minimum: 0,
      },
      timeout: {
        type: 'integer',
        default: 3600,
        maximum: 36000,
        minimum: 60,
      },
    },
    type: 'object',
    additionalProperties: false,
  },
};
