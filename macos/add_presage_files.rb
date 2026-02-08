#!/usr/bin/env ruby

require 'xcodeproj'

project_path = 'signal-app.xcodeproj'
project = Xcodeproj::Project.open(project_path)

# Find the signal-app-macOS target
target = project.targets.find { |t| t.name == 'signal-app-macOS' }
raise "Could not find signal-app-macOS target" unless target

# Find the signal-app-macOS group
main_group = project.main_group
macos_group = main_group.groups.find { |g| g.path == 'signal-app-macOS' }
raise "Could not find signal-app-macOS group" unless macos_group

# Create Generated group
generated_group = main_group.groups.find { |g| g.name == 'Generated' }
unless generated_group
  generated_group = main_group.new_group('Generated', 'Generated')
end

# Add bridging header to group (but not to build)
bridging_header_path = 'signal-app-macOS/signal-app-macOS-Bridging-Header.h'
unless macos_group.files.any? { |f| f.path == 'signal-app-macOS-Bridging-Header.h' }
  bridging_header = macos_group.new_file('signal-app-macOS-Bridging-Header.h')
end

# Add PresageModule.swift to group and build
presage_swift_path = 'signal-app-macOS/PresageModule.swift'
presage_swift_ref = macos_group.files.find { |f| f.path == 'PresageModule.swift' }
unless presage_swift_ref
  presage_swift_ref = macos_group.new_file('PresageModule.swift')
end
target.add_file_references([presage_swift_ref]) unless target.source_build_phase.files.any? { |f| f.file_ref == presage_swift_ref }

# Add PresageModule.m to group and build
presage_m_path = 'signal-app-macOS/PresageModule.m'
presage_m_ref = macos_group.files.find { |f| f.path == 'PresageModule.m' }
unless presage_m_ref
  presage_m_ref = macos_group.new_file('PresageModule.m')
end
target.add_file_references([presage_m_ref]) unless target.source_build_phase.files.any? { |f| f.file_ref == presage_m_ref }

# Add presage_rn.swift to Generated group and build
presage_rn_swift_ref = generated_group.files.find { |f| f.path == 'presage_rn.swift' }
unless presage_rn_swift_ref
  presage_rn_swift_ref = generated_group.new_file('presage_rn.swift')
end
target.add_file_references([presage_rn_swift_ref]) unless target.source_build_phase.files.any? { |f| f.file_ref == presage_rn_swift_ref }

# Add presage_rnFFI.h to Generated group (header, not compiled)
ffi_header_ref = generated_group.files.find { |f| f.path == 'presage_rnFFI.h' }
unless ffi_header_ref
  ffi_header_ref = generated_group.new_file('presage_rnFFI.h')
end

# Add libpresage_rn.a to Generated group and link
lib_ref = generated_group.files.find { |f| f.path == 'libpresage_rn.a' }
unless lib_ref
  lib_ref = generated_group.new_file('libpresage_rn.a')
end
# Add to frameworks build phase
frameworks_phase = target.frameworks_build_phase
unless frameworks_phase.files.any? { |f| f.file_ref == lib_ref }
  frameworks_phase.add_file_reference(lib_ref)
end

# Update build settings for the macOS target
target.build_configurations.each do |config|
  settings = config.build_settings

  # Set bridging header
  settings['SWIFT_OBJC_BRIDGING_HEADER'] = 'signal-app-macOS/signal-app-macOS-Bridging-Header.h'

  # Add header search paths
  header_paths = settings['HEADER_SEARCH_PATHS'] || ['$(inherited)']
  header_paths = [header_paths] if header_paths.is_a?(String)
  unless header_paths.include?('$(SRCROOT)/Generated')
    header_paths << '$(SRCROOT)/Generated'
  end
  settings['HEADER_SEARCH_PATHS'] = header_paths

  # Add library search paths
  lib_paths = settings['LIBRARY_SEARCH_PATHS'] || ['$(inherited)']
  lib_paths = [lib_paths] if lib_paths.is_a?(String)
  unless lib_paths.include?('$(SRCROOT)/Generated')
    lib_paths << '$(SRCROOT)/Generated'
  end
  settings['LIBRARY_SEARCH_PATHS'] = lib_paths

  # Add import paths for Swift module
  import_paths = settings['SWIFT_INCLUDE_PATHS'] || ['$(inherited)']
  import_paths = [import_paths] if import_paths.is_a?(String)
  unless import_paths.include?('$(SRCROOT)/Generated')
    import_paths << '$(SRCROOT)/Generated'
  end
  settings['SWIFT_INCLUDE_PATHS'] = import_paths
end

project.save

puts "Successfully added Presage files to Xcode project!"
puts "Files added:"
puts "  - signal-app-macOS/PresageModule.swift"
puts "  - signal-app-macOS/PresageModule.m"
puts "  - signal-app-macOS/signal-app-macOS-Bridging-Header.h"
puts "  - Generated/presage_rn.swift"
puts "  - Generated/presage_rnFFI.h"
puts "  - Generated/libpresage_rn.a"
