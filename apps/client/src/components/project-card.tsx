import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ProjectSummary } from '@github-personal-assistant/shared';

export function ProjectCard({ project, onPress }: { project: ProjectSummary; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.card, pressed && styles.pressed]} onPress={onPress}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{project.name}</Text>
        <View style={styles.modelBadge}>
          <Text style={styles.modelText}>{project.defaultModel}</Text>
        </View>
      </View>
      <Text style={styles.description}>{project.description}</Text>
      <Text style={styles.updatedAt}>Updated {new Date(project.updatedAt).toLocaleString()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#141b34',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 18,
    gap: 12,
  },
  pressed: {
    opacity: 0.88,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
  },
  title: {
    color: '#f7fafc',
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
  },
  modelBadge: {
    backgroundColor: '#25345b',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modelText: {
    color: '#dbeafe',
    fontSize: 12,
    fontWeight: '600',
  },
  description: {
    color: '#d6def5',
    fontSize: 14,
    lineHeight: 20,
  },
  updatedAt: {
    color: '#8ea0d0',
    fontSize: 12,
  },
});
