package store_test

import "testing"

func TestSendMessageReply(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	parent, _, err := s.SendMessage(chatID, a.ID, "parent", "iv", "text", nil, "cid-parent", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	reply, _, err := s.SendMessage(chatID, b.ID, "reply", "iv", "text", nil, "cid-reply", nil, &parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reply.ReplyToMessageID == nil || *reply.ReplyToMessageID != parent.ID {
		t.Fatalf("expected replyTo=%s, got %#v", parent.ID, reply.ReplyToMessageID)
	}
	msgs, err := s.GetMessages(chatID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, m := range msgs {
		if m.ID == reply.ID {
			found = true
			if m.ReplyToMessageID == nil || *m.ReplyToMessageID != parent.ID {
				t.Fatalf("loaded reply missing parent: %#v", m.ReplyToMessageID)
			}
		}
	}
	if !found {
		t.Fatal("reply not in GetMessages")
	}

	bad := "missing-id"
	if _, _, err := s.SendMessage(chatID, a.ID, "x", "iv", "text", nil, "cid-bad", nil, &bad); err == nil || err.Error() != "invalid reply" {
		t.Fatalf("expected invalid reply, got %v", err)
	}
}
