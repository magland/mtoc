% A string variable assigned only inside a for-loop body: the
% post-loop merge of (post-body env) with (pre-loop env, which
% doesn't have `msg`) must accept the loop-introduced String.
total = 0;
for i = 1:3
  msg = "iter";
  total = total + i;
end
disp(msg);
disp(total);
